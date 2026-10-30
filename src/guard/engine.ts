import type { GuardRules } from "../rules.js";
import type { GuardSnapshot, Origin } from "../types.js";
import { distToLiqPct, health } from "./trigger.js";

export type ActionLevel = "flatten" | "trim" | "sl" | "tp";
export type AlertLevel = "warn" | "suggest-trim" | "suggest-flatten" | "rate-limited";

export const HYSTERESIS = 0.1;
export const MAX_ACTIONS_PER_HOUR = 6;
export const STALE_AFTER_MS = 30_000;
export const MIN_BOT_STT = 0.05;
/** Flatten retries fast (an IOC can find no fill); a trim waits for the account to settle. */
export const COOLDOWN_MS: Record<ActionLevel, number> = { flatten: 3_000, trim: 20_000, sl: 5_000, tp: 5_000 };

export interface GuardState {
  armed: { warn: boolean; trim: boolean; flatten: boolean };
  lastActionAt: Partial<Record<ActionLevel, number>>;
  /** Times of automatic actions within the last hour. */
  actionTimes: number[];
  /** `${level}:${block}` of the last action, so one block never acts twice. */
  lastKey: string | null;
  snoozedUntil: number | null;
  rateLimitAlerted: boolean;
}

export function initialGuardState(): GuardState {
  return { armed: { warn: true, trim: true, flatten: true }, lastActionAt: {}, actionTimes: [], lastKey: null, snoozedUntil: null, rateLimitAlerted: false };
}

export interface GuardContext {
  origin: Origin | null;
  tpPx: number | null;
  slPx: number | null;
  /** ATR(14) of closed 15m candles in % of price, or null before warm-up. */
  atrPct: number | null;
  dataAgeMs: number;
  botStt: number | null;
  linkOk: boolean;
  /** "daily loss limit reached" etc., computed from day_state. */
  dailyBlock: string | null;
}

export interface GuardAction {
  level: ActionLevel;
  /** Fraction of the position to close, 0..1. */
  fraction: number;
  reason: string;
  key: string;
}

export interface GuardAlert {
  level: AlertLevel;
  reason: string;
}

export interface GuardDecision {
  action: GuardAction | null;
  alert: GuardAlert | null;
  /** Reasons new strategy entries are blocked; empty means entries are allowed. */
  blocks: string[];
  health: number;
  distLiqPct: number | null;
  state: GuardState;
}

const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "∞");

function cloneState(s: GuardState): GuardState {
  return { ...s, armed: { ...s.armed }, lastActionAt: { ...s.lastActionAt }, actionTimes: [...s.actionTimes] };
}

/** Re-arm a level whose action failed to execute, so the next push can try again. */
export function rearm(state: GuardState, level: "trim" | "flatten"): GuardState {
  const s = cloneState(state);
  s.armed[level] = true;
  s.lastKey = null;
  return s;
}

export function snooze(state: GuardState, untilMs: number): GuardState {
  return { ...cloneState(state), snoozedUntil: untilMs };
}

/**
 * Pure: the same snapshot, rules, context and state always give the same decision.
 * Priority: flatten > trim > strategy SL/TP > warn. Blocks are reported alongside.
 */
export function evaluateGuard(snap: GuardSnapshot, rules: GuardRules, ctx: GuardContext, prev: GuardState): GuardDecision {
  const now = snap.observedAtMs;
  const h = health(snap);
  const dist = distToLiqPct(snap);
  const s = cloneState(prev);
  s.actionTimes = s.actionTimes.filter((t) => now - t < 3_600_000);

  const blocks: string[] = [];
  if (ctx.dataAgeMs > STALE_AFTER_MS) blocks.push(`account data stale (${Math.round(ctx.dataAgeMs / 1000)} s old)`);
  if (ctx.botStt !== null && ctx.botStt < MIN_BOT_STT) blocks.push(`bot gas low (${ctx.botStt.toFixed(3)} STT)`);
  if (!ctx.linkOk) blocks.push("bot key not linked to the account");
  if (ctx.dailyBlock) blocks.push(ctx.dailyBlock);
  if (h < rules.warnHealth) blocks.push(`health ${fmt(h)} < warn ${rules.warnHealth}`);

  const result = (action: GuardAction | null, alert: GuardAlert | null): GuardDecision => ({ action, alert, blocks, health: h, distLiqPct: dist, state: s });

  const pos = snap.position;
  if (!pos) {
    s.armed = { warn: true, trim: true, flatten: true };
    s.snoozedUntil = null;
    s.rateLimitAlerted = false;
    return result(null, null);
  }
  if (!rules.enabled) return result(null, null);

  const atr = ctx.atrPct !== null && ctx.atrPct > 0 ? ctx.atrPct : null;
  const flattenBuf = atr !== null ? rules.atrFlattenMult * atr : 0;
  const trimBuf = atr !== null ? rules.atrTrimMult * atr : 0;
  const nearFlatten = dist !== null && dist < flattenBuf;
  const nearTrim = dist !== null && dist < trimBuf;

  if (!s.armed.flatten && h >= rules.flattenHealth + HYSTERESIS && !nearFlatten) s.armed.flatten = true;
  if (!s.armed.trim && h >= rules.trimHealth + HYSTERESIS && !nearTrim) s.armed.trim = true;
  if (!s.armed.warn && h >= rules.warnHealth + HYSTERESIS) s.armed.warn = true;

  const coolingDown = (level: ActionLevel) => {
    const last = s.lastActionAt[level];
    return last !== undefined && now - last < COOLDOWN_MS[level];
  };
  const rateLimited = s.actionTimes.length >= MAX_ACTIONS_PER_HOUR;

  const canAct = (level: ActionLevel) => `${level}:${snap.block}` !== s.lastKey && !coolingDown(level);
  const act = (level: ActionLevel, fraction: number, reason: string, counted: boolean): GuardDecision => {
    const key = `${level}:${snap.block}`;
    s.lastKey = key;
    s.lastActionAt[level] = now;
    if (counted) s.actionTimes.push(now);
    return result({ level, fraction, reason, key }, null);
  };

  const distTxt = dist !== null ? `, liq ${dist.toFixed(2)}% away` : "";

  const flattenWhy = h < rules.flattenHealth ? `health ${fmt(h)} < ${rules.flattenHealth}` : nearFlatten ? `liq ${dist!.toFixed(2)}% away < ${rules.atrFlattenMult}× ATR ${atr!.toFixed(2)}%` : null;
  if (flattenWhy && s.armed.flatten) {
    if (rules.mode === "alert") {
      s.armed.flatten = false;
      s.armed.trim = false;
      return result(null, { level: "suggest-flatten", reason: `${flattenWhy}${distTxt}` });
    }
    if (rateLimited) {
      s.armed.flatten = false;
      s.armed.trim = false;
      return rateLimitedAlert(s, result, flattenWhy);
    }
    if (canAct("flatten")) {
      s.armed.flatten = false;
      s.armed.trim = false;
      return act("flatten", 1, flattenWhy, true);
    }
    return result(null, null);
  }

  const trimWhy = h < rules.trimHealth ? `health ${fmt(h)} < ${rules.trimHealth}` : nearTrim ? `liq ${dist!.toFixed(2)}% away < ${rules.atrTrimMult}× ATR ${atr!.toFixed(2)}%` : null;
  const snoozed = s.snoozedUntil !== null && now < s.snoozedUntil;
  if (trimWhy && s.armed.trim && !snoozed) {
    if (rules.mode === "alert") {
      s.armed.trim = false;
      return result(null, { level: "suggest-trim", reason: `${trimWhy}${distTxt}` });
    }
    if (rateLimited) {
      s.armed.trim = false;
      return rateLimitedAlert(s, result, trimWhy);
    }
    if (canAct("trim")) {
      s.armed.trim = false;
      return act("trim", rules.trimPct / 100, trimWhy, true);
    }
  }

  if (ctx.origin === "strategy") {
    const long = pos.side === "long";
    if (ctx.slPx !== null && (long ? pos.mark <= ctx.slPx : pos.mark >= ctx.slPx)) {
      if (canAct("sl")) return act("sl", 1, `mark ${pos.mark.toFixed(1)} crossed stop ${ctx.slPx.toFixed(1)}`, false);
    } else if (ctx.tpPx !== null && (long ? pos.mark >= ctx.tpPx : pos.mark <= ctx.tpPx)) {
      if (canAct("tp")) return act("tp", 1, `mark ${pos.mark.toFixed(1)} reached take-profit ${ctx.tpPx.toFixed(1)}`, false);
    }
  }

  if (h < rules.warnHealth && s.armed.warn) {
    s.armed.warn = false;
    return result(null, { level: "warn", reason: `health ${fmt(h)} < warn ${rules.warnHealth}${distTxt}` });
  }

  return result(null, null);
}

function rateLimitedAlert(s: GuardState, result: (a: GuardAction | null, b: GuardAlert | null) => GuardDecision, why: string): GuardDecision {
  if (s.rateLimitAlerted) return result(null, null);
  s.rateLimitAlerted = true;
  return result(null, { level: "rate-limited", reason: `${why}, but ${MAX_ACTIONS_PER_HOUR} automatic actions already ran this hour: alert-only until it cools down` });
}
