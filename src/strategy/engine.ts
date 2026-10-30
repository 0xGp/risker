import type { StrategyParams } from "../params.js";
import type { Candle, Origin, Side } from "../types.js";
import { ema } from "./indicators.js";

export const WARMUP_CANDLES = 30;
const M15 = 900_000;
const H1 = 3_600_000;

export type Intent = { kind: "open"; side: Side } | { kind: "close" } | { kind: "none" };

export interface StrategyPosition {
  side: Side;
  origin: Origin;
}

export interface DayState {
  trades: number;
  /** Realized + unrealized PnL today (WAT), USDso. */
  pnlUsd: number;
}

export interface Decision {
  intent: Intent;
  reason: string;
  /** The closed candle this decision is for. */
  candleTs: number;
}

const px = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });

/** Raw entry/exit signal on the last closed candle, before position and day rules. */
function signal(closed: Candle[], hourly: Candle[], p: StrategyParams): { side: Side | null; reason: string } {
  const last = closed.at(-1)!;
  if (p.preset === "breakout") {
    const lastClose = last.ts + M15;
    const prior = hourly.filter((h) => h.ts + H1 <= lastClose).at(-1);
    if (!prior) return { side: null, reason: "no completed 1h candle yet" };
    const buf = p.breakout.bufferPct / 100;
    const up = prior.high * (1 + buf);
    const down = prior.low * (1 - buf);
    if (last.close > up) return { side: "long", reason: `close ${px(last.close)} > 1h high ${px(prior.high)} +${p.breakout.bufferPct}%` };
    if (last.close < down) return { side: "short", reason: `close ${px(last.close)} < 1h low ${px(prior.low)} −${p.breakout.bufferPct}%` };
    return { side: null, reason: `close ${px(last.close)} inside 1h range ${px(prior.low)}–${px(prior.high)}` };
  }
  const closes = closed.map((c) => c.close);
  const fast = ema(closes, p.trend.fast);
  const slow = ema(closes, p.trend.slow);
  const [f1, s1, f0, s0] = [fast.at(-2)!, slow.at(-2)!, fast.at(-1)!, slow.at(-1)!];
  if ([f1, s1, f0, s0].some((v) => !Number.isFinite(v))) return { side: null, reason: "EMAs warming up" };
  const tag = `EMA${p.trend.fast} ${px(f0)} vs EMA${p.trend.slow} ${px(s0)}`;
  if (f1 <= s1 && f0 > s0) return { side: "long", reason: `${tag}: crossed above` };
  if (f1 >= s1 && f0 < s0) return { side: "short", reason: `${tag}: crossed below` };
  return { side: null, reason: `${tag}: no cross` };
}

/**
 * Pure: no clock, no I/O, no randomness. Same candles + position + params + day state → same decision.
 * `closed15m` must hold only closed candles, ascending.
 */
export function decide(closed15m: Candle[], candles1h: Candle[], position: StrategyPosition | null, p: StrategyParams, day: DayState): Decision {
  const last = closed15m.at(-1);
  const candleTs = last?.ts ?? 0;
  const out = (intent: Intent, reason: string): Decision => ({ intent, reason, candleTs });

  if (closed15m.length < WARMUP_CANDLES) return out({ kind: "none" }, `warm-up: ${closed15m.length}/${WARMUP_CANDLES} closed 15m candles`);

  const sig = signal(closed15m, candles1h, p);

  if (position) {
    if (position.origin === "manual") return out({ kind: "none" }, `manual position open, strategy stands aside (${sig.reason})`);
    if (sig.side && sig.side !== position.side) return out({ kind: "close" }, `opposite signal: ${sig.reason}`);
    return out({ kind: "none" }, `holding ${position.side} (${sig.reason})`);
  }

  if (!sig.side) return out({ kind: "none" }, sig.reason);
  if (p.direction !== "both" && p.direction !== sig.side) return out({ kind: "none" }, `${sig.side} signal ignored, direction is ${p.direction}-only (${sig.reason})`);
  if (day.trades >= p.maxTradesPerDay) return out({ kind: "none" }, `max ${p.maxTradesPerDay} trades/day reached (${sig.reason})`);
  if (-day.pnlUsd >= p.dailyLossLimitUsd) return out({ kind: "none" }, `daily loss limit $${p.dailyLossLimitUsd} reached (${sig.reason})`);
  return out({ kind: "open", side: sig.side }, sig.reason);
}

/** TP/SL prices stored at fill. */
export function bracket(side: Side, entry: number, p: StrategyParams): { tp: number; sl: number } {
  const dir = side === "long" ? 1 : -1;
  return { tp: entry * (1 + (dir * p.tpPct) / 100), sl: entry * (1 - (dir * p.slPct) / 100) };
}
