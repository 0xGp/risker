import { arbitrate } from "./arbiter.js";
import { CandleClock, type CandleBatch } from "./candles.js";
import { botStt, linkOk, type Chain } from "./chain.js";
import { txUrl, type Config } from "./config.js";
import { dayWat, type PositionMeta, type Store } from "./db.js";
import type { Executor, ExecResult } from "./executor.js";
import { evaluateGuard, initialGuardState, rearm, snooze, type GuardDecision, type GuardState } from "./guard/engine.js";
import { health, healthAfterTrim, triggerPrice, triggers } from "./guard/trigger.js";
import { paramsHash, type StrategyParams } from "./params.js";
import type { GuardRules } from "./rules.js";
import { bracket, decide } from "./strategy/engine.js";
import { atrPct } from "./strategy/indicators.js";
import type { GuardSnapshot, Origin, Side } from "./types.js";
import { Watcher, type WatchEvent } from "./watcher.js";

export interface Button {
  text: string;
  data?: string;
  url?: string;
}

export interface Notifier {
  send(text: string, buttons?: Button[][]): Promise<void>;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
export const px = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : n.toLocaleString("en-US", { maximumFractionDigits: 1 }));
export const hx = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "∞");
const btc = (n: number) => n.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
const watTime = (ms: number) => new Date(ms + 3_600_000).toISOString().slice(11, 16) + " WAT";

interface StrategyState {
  params: StrategyParams;
  version: number;
  armed: boolean;
  paused: boolean;
}

export class App {
  rules!: GuardRules;
  rulesVersion = 0;
  guardState: GuardState = initialGuardState();
  strategy: StrategyState | null = null;
  atr: number | null = null;
  lastBatch: CandleBatch | null = null;
  lastSnap: GuardSnapshot | null = null;
  lastDecision: GuardDecision | null = null;
  stt: number | null = null;
  link = { ok: false, place: false, cancel: false, reduce: false };
  readonly watcher: Watcher;
  readonly clock: CandleClock;
  private pendingStrategy: { until: number; side: Side } | null = null;
  private ownActionUntil = 0;
  private lastSnapshotSaved = 0;
  private unreadableAlerted = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    readonly c: Chain,
    readonly cfg: Config,
    readonly store: Store,
    readonly exec: Executor,
    readonly notify: Notifier,
  ) {
    this.watcher = new Watcher(c, (e) => this.onWatch(e));
    this.clock = new CandleClock(c.exchange, (b) => this.onCandles(b));
  }

  async start(): Promise<void> {
    const g = this.store.guardRules();
    this.rules = g.rules;
    this.rulesVersion = g.version;
    this.strategy = this.store.strategy();
    await this.refreshHealthChecks();
    try {
      const batch = await this.clock.load();
      this.lastBatch = batch;
      this.atr = atrPct(batch.closed15m);
    } catch (err) {
      console.log(`initial candle load failed: ${(err as Error).message}`);
    }
    this.watcher.start();
    this.clock.start();
    this.timers.push(setInterval(() => void this.refreshHealthChecks(), 60_000));
    this.scheduleRecap();
  }

  stop(): void {
    this.watcher.close();
    this.clock.close();
    for (const t of this.timers) clearInterval(t);
  }

  private async refreshHealthChecks(): Promise<void> {
    try {
      this.stt = await botStt(this.c);
      const prev = this.link.ok;
      this.link = await linkOk(this.c);
      if (prev && !this.link.ok) await this.notify.send("⚠️ Guard blind: the bot key is no longer linked to your account. Re-link it in the app (Link a bot → Perps).");
    } catch (err) {
      console.log(`health checks failed: ${(err as Error).message}`);
    }
  }

  // ---------- guard ----------

  private guardCtx(meta: PositionMeta | null, dataAgeMs: number) {
    return {
      origin: (meta?.origin ?? null) as Origin | null,
      tpPx: meta?.origin === "strategy" ? meta.tp_px : null,
      slPx: meta?.origin === "strategy" ? meta.sl_px : null,
      atrPct: this.atr,
      dataAgeMs,
      botStt: this.stt,
      linkOk: this.link.ok || this.cfg.dryRun,
      dailyBlock: this.dailyBlock(),
    };
  }

  dailyBlock(now = Date.now()): string | null {
    const s = this.strategy;
    if (!s) return null;
    const day = this.store.day(dayWat(now));
    const meta = this.store.openPosition();
    const upnl = meta?.origin === "strategy" ? (this.lastSnap?.position?.unrealizedPnl ?? 0) : 0;
    if (-(day.realized_pnl + upnl) >= s.params.dailyLossLimitUsd) return `daily loss limit ${usd(s.params.dailyLossLimitUsd)} reached`;
    if (day.trades >= s.params.maxTradesPerDay) return `max ${s.params.maxTradesPerDay} trades/day reached`;
    return null;
  }

  private onWatch(e: WatchEvent): void {
    if (!e.snapshot) {
      if (!this.unreadableAlerted) {
        this.unreadableAlerted = true;
        void this.notify.send("⚠️ Account health is unreadable right now (BTC-PERP un-priceable or a read failed). Entries are blocked; the guard resumes when prices return.");
      }
      return;
    }
    this.unreadableAlerted = false;
    const snap = e.snapshot;
    const prevSnap = this.lastSnap;
    this.lastSnap = snap;
    const now = Date.now();
    if (now - this.lastSnapshotSaved > 60_000) {
      this.lastSnapshotSaved = now;
      this.store.recordSnapshot({ block: snap.block, mark: snap.position?.mark ?? null, liq: snap.position?.liqPrice ?? null, equity: snap.equity, mmReq: snap.mmReq, health: health(snap), size: snap.position?.size ?? 0, source: e.source, now });
    }
    this.adopt(snap, prevSnap);
    const meta = this.store.openPosition();
    const d = evaluateGuard(snap, this.rules, this.guardCtx(meta, 0), this.guardState);
    this.guardState = d.state;
    this.lastDecision = d;
    if (d.alert) void this.sendAlert(d, snap);
    if (d.action) void this.runGuardAction(d, snap, meta);
  }

  private adopt(snap: GuardSnapshot, prev: GuardSnapshot | null): void {
    const pos = snap.position;
    let meta = this.store.openPosition();
    const now = Date.now();
    if (meta && (!pos || pos.side !== meta.side)) {
      const lastMark = prev?.position?.mark ?? meta.entry_px;
      const dir = meta.side === "long" ? 1 : -1;
      const pnl = meta.origin === "strategy" ? (lastMark - meta.entry_px) * meta.qty * dir : null;
      this.store.closePosition(meta.id, now, pnl, null);
      if (pnl !== null) this.store.addRealized(dayWat(now), pnl);
      if (now > this.ownActionUntil) void this.notify.send(`ℹ️ Your BTC ${meta.side} (${meta.origin}) is closed. Guard idle until the next position.`);
      meta = null;
    }
    if (!pos) return;
    if (!meta) {
      const fromStrategy = this.pendingStrategy !== null && now < this.pendingStrategy.until && this.pendingStrategy.side === pos.side;
      const origin: Origin = fromStrategy ? "strategy" : "manual";
      const br = fromStrategy && this.strategy ? bracket(pos.side, pos.entry, this.strategy.params) : null;
      this.store.adopt({ origin, side: pos.side, qty: pos.size, entry: pos.entry, tp: br?.tp ?? null, sl: br?.sl ?? null, now });
      this.pendingStrategy = null;
      void this.notify.send(this.adoptionText(snap, origin, br), [[{ text: "Close all", data: "close:100" }, { text: "Snooze trims 15m", data: "snooze" }]]);
      return;
    }
    if (Math.abs(pos.size - meta.qty) > 1e-9) {
      const grew = pos.size > meta.qty;
      this.store.updatePosition(meta.id, { qty: pos.size, entry_px: pos.entry });
      if (grew && now > this.ownActionUntil) void this.notify.send(`➕ Position size changed to ${btc(pos.size)} BTC.\n${this.triggerLines(snap)}`);
    }
  }

  private adoptionText(snap: GuardSnapshot, origin: Origin, br: { tp: number; sl: number } | null): string {
    const p = snap.position!;
    const lev = snap.equity > 0 ? p.notional / snap.equity : 0;
    const head = origin === "manual" ? `🛡️ Watching your ${lev.toFixed(1)}x ${p.side}` : `🤖 Strategy ${p.side} filled`;
    const lines = [
      `${head}: ${btc(p.size)} BTC @ ${px(p.entry)} (${usd(p.notional)}), health ${hx(health(snap))}`,
      this.triggerLines(snap),
      `Profile: ${this.rules.profile}, ${this.rules.mode === "protect" ? "auto-protect" : "alert only"}${this.rules.enabled ? "" : " (guard OFF)"}`,
    ];
    if (br) lines.push(`Bot-side TP ${px(br.tp)} · SL ${px(br.sl)}`);
    return lines.join("\n");
  }

  triggerLines(snap: GuardSnapshot): string {
    const t = triggers(snap, this.rules);
    return `Warn ≈ ${px(t.warn)} · Trim ≈ ${px(t.trim)} · Flatten ≈ ${px(t.flatten)} · Liq ≈ ${px(t.liq)}`;
  }

  private async sendAlert(d: GuardDecision, snap: GuardSnapshot): Promise<void> {
    const a = d.alert!;
    const p = snap.position;
    const where = p ? `BTC ${px(p.mark)} · ${p.side} ${btc(p.size)} · liq ≈ ${px(p.liqPrice ?? triggerPrice(snap, 1))}` : "";
    const buttons: Button[][] = [[{ text: `Trim ${this.rules.trimPct}%`, data: `close:${this.rules.trimPct}` }, { text: "Close all", data: "close:100" }, { text: "Ignore", data: "ignore" }]];
    switch (a.level) {
      case "warn":
        return this.notify.send(`⚠️ Health ${hx(d.health)}: ${a.reason}. New strategy entries blocked.\n${where}\n${this.triggerLines(snap)}`, [[{ text: "Add margin in the app ↗", url: "https://app.testnet.dreamdex.io" }]]);
      case "suggest-trim":
        return this.notify.send(`🟠 Trim suggested (alert-only mode): ${a.reason}\n${where}`, buttons);
      case "suggest-flatten":
        return this.notify.send(`🔴 Close suggested (alert-only mode): ${a.reason}\n${where}`, buttons);
      case "rate-limited":
        return this.notify.send(`⏸️ ${a.reason}\n${where}`, buttons);
    }
  }

  private async runGuardAction(d: GuardDecision, snap: GuardSnapshot, meta: PositionMeta | null): Promise<void> {
    const a = d.action!;
    const p = snap.position!;
    const minQty = Number(BigInt(this.c.market.info.minQuantity)) / 10 ** this.c.market.info.baseDecimals;
    if (a.fraction < 1 && p.size * a.fraction < minQty) {
      if (a.level === "trim") {
        this.guardState = rearm(this.guardState, "trim");
        await this.notify.send(`🟠 ${a.reason}, but ${this.rules.trimPct}% of ${btc(p.size)} BTC is below the ${minQty} BTC minimum.`, [[{ text: "Close all", data: "close:100" }]]);
        return;
      }
    }
    const hBefore = health(snap);
    const liqBefore = p.liqPrice ?? triggerPrice(snap, 1);
    const s = this.cfg.slippageBps;
    const slippages = a.level === "flatten" ? [s, s * 2, s * 4, Math.min(200, s * 8)] : [s, s * 2];
    this.ownActionUntil = Date.now() + 30_000;
    const kind = a.level === "sl" || a.level === "tp" ? `strategy-${a.level}` : `guard-${a.level}`;
    const res = await this.exec.reduce({ fraction: a.fraction, kind, reason: a.reason, side: p.side, mark: p.mark, slippages, extra: { healthBefore: hBefore, block: snap.block } });
    const doneFraction = res.filled > 0 ? Math.min(1, res.filled / p.size) : a.fraction;
    const hAfter = res.status === "filled" || res.status === "dry-run" ? healthAfterTrim(snap, doneFraction) : null;
    const after: GuardSnapshot = { ...snap, mmReq: snap.mmReq - p.mm * doneFraction, position: doneFraction >= 1 ? null : { ...p, size: p.size * (1 - doneFraction), mm: p.mm * (1 - doneFraction), notional: p.notional * (1 - doneFraction), liqPrice: null } };
    const liqAfter = after.position ? triggerPrice(after, 1) : null;
    this.store.recordGuardAction({ level: a.level, mode: this.rules.mode, origin: meta?.origin ?? null, healthBefore: hBefore, healthAfter: hAfter, liqBefore, liqAfter, mark: p.mark, qty: res.filled || p.size * a.fraction, tx: res.hash ?? null, status: res.status, reason: a.reason, block: snap.block, rulesVersion: this.rulesVersion, now: Date.now() });

    if (res.status === "failed" || res.status === "no-fill" || res.status === "skipped") {
      if (a.level === "trim" || a.level === "flatten") this.guardState = rearm(this.guardState, a.level);
      await this.notify.send(`❌ ${a.level.toUpperCase()} did not execute (${res.status}${res.detail ? `: ${res.detail}` : ""}). Retrying on the next update.`, [[{ text: "Close all", data: "close:100" }]]);
      return;
    }
    if (a.level === "trim" || a.level === "flatten") this.store.bumpDay(dayWat(Date.now()), "guard_saves");
    await this.notify.send(this.actionText(a.level, a.reason, res, p, hBefore, hAfter, liqBefore, liqAfter), this.shareButtons(a.level, hBefore, hAfter, res));
  }

  private actionText(level: string, reason: string, res: ExecResult, p: NonNullable<GuardSnapshot["position"]>, hBefore: number, hAfter: number | null, liqBefore: number | null, liqAfter: number | null): string {
    const title = { flatten: "🛡️ RiskGuard: FLATTEN", trim: `🛡️ RiskGuard: TRIM ${this.rules.trimPct}%`, sl: "🤖 Strategy stop-loss", tp: "🤖 Strategy take-profit" }[level] ?? level;
    const dry = res.status === "dry-run" ? " (DRY RUN, nothing sent)" : "";
    const room = liqBefore !== null && liqAfter !== null ? ` (${usd(Math.abs(liqBefore - liqAfter))} more room)` : "";
    const lines = [
      `${title}${dry}`,
      `BTC ${px(p.mark)} · health ${hx(hBefore)} → ${hAfter === null ? "n/a" : hx(hAfter)}${level === "trim" ? " ≈" : ""}`,
      level === "trim" ? `Liq ${px(liqBefore)} → ≈${px(liqAfter)}${room}` : `Closed ${btc(res.filled || p.size)} BTC`,
      `Reason: ${reason}`,
    ];
    if (res.hash) lines.push(`tx: ${txUrl(this.cfg, res.hash)}`);
    return lines.join("\n");
  }

  shareButtons(level: string, hBefore: number, hAfter: number | null, res: ExecResult): Button[][] {
    if (!res.hash || (level !== "trim" && level !== "flatten")) return [];
    const text = `RiskGuard just ${level === "trim" ? "trimmed" : "closed"} my BTC-PERP position before liquidation on @DreamDEXSomnia 🛡️ Health ${hx(hBefore)} → ${hAfter === null ? "safe" : hx(hAfter)}. ${txUrl(this.cfg, res.hash)}`;
    const row: Button[] = [{ text: "Share on X", url: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}` }];
    if (this.cfg.botUsername) row.push({ text: "Get RiskGuard", url: `https://t.me/${this.cfg.botUsername}?start=saved` });
    return [row];
  }

  // ---------- strategy ----------

  private async onCandles(batch: CandleBatch): Promise<void> {
    this.lastBatch = batch;
    this.atr = atrPct(batch.closed15m);
    const s = this.strategy;
    if (!s?.armed || this.store.decided(batch.expectedTs)) return;
    const meta = this.store.openPosition();
    const day = this.store.day(dayWat(Date.now()));
    const upnl = meta?.origin === "strategy" ? (this.lastSnap?.position?.unrealizedPnl ?? 0) : 0;
    const dec = decide(batch.closed15m, batch.hourly, meta ? { side: meta.side, origin: meta.origin } : null, s.params, { trades: day.trades, pnlUsd: day.realized_pnl + upnl });
    const blocks = this.entryBlocks();
    const arb = arbitrate({ action: null, alert: null, blocks, health: 0, distLiqPct: null, state: this.guardState }, dec, meta?.origin ?? null, s.paused);

    let executed = false;
    let tx: string | null = null;
    let blockedBy: string | null = arb.source === "none" && dec.intent.kind !== "none" ? arb.reason : null;
    const mark = this.lastSnap?.position?.mark ?? batch.closed15m.at(-1)?.close ?? 0;
    const extra = { candleTs: dec.candleTs, preset: s.params.preset, paramsVersion: s.version, paramsHash: paramsHash(s.params) };

    if (arb.source === "strategy" && dec.intent.kind === "open") {
      const equity = this.lastSnap?.equity ?? 0;
      if (equity <= 0 || s.params.sizeUsd / equity > s.params.leverage) {
        blockedBy = `effective leverage ${(equity > 0 ? s.params.sizeUsd / equity : Infinity).toFixed(1)}x would exceed the ${s.params.leverage}x cap`;
      } else {
        this.pendingStrategy = { until: Date.now() + 60_000, side: dec.intent.side };
        const res = await this.exec.open({ side: dec.intent.side, sizeUsd: s.params.sizeUsd, mark, reason: dec.reason, extra });
        executed = res.status === "filled" || res.status === "dry-run";
        tx = res.hash ?? null;
        if (res.status === "filled") this.store.bumpDay(dayWat(Date.now()), "trades");
        if (res.status !== "filled") this.pendingStrategy = null;
        if (res.status === "failed" || res.status === "no-fill") blockedBy = res.detail ?? res.status;
      }
    } else if (arb.source === "strategy" && dec.intent.kind === "close" && this.lastSnap?.position) {
      this.ownActionUntil = Date.now() + 30_000;
      const res = await this.exec.reduce({ fraction: 1, kind: "strategy-close", reason: dec.reason, side: this.lastSnap.position.side, mark, extra });
      executed = res.status === "filled" || res.status === "dry-run";
      tx = res.hash ?? null;
    }

    this.store.recordDecision({ candleTs: dec.candleTs, preset: s.params.preset, paramsVersion: s.version, paramsHash: paramsHash(s.params), intent: dec.intent.kind === "open" ? `open-${dec.intent.side}` : dec.intent.kind, reason: dec.reason, executed, blockedBy, tx, now: Date.now() });

    if (dec.intent.kind !== "none" || this.cfg.notifyEveryCandle) {
      const head = `🕒 ${watTime(dec.candleTs + 900_000)} · ${s.params.preset}: ${dec.intent.kind === "open" ? `open ${dec.intent.side}` : dec.intent.kind}`;
      const lines = [head, `Reason: ${dec.reason}`];
      if (blockedBy) lines.push(`Not executed: ${blockedBy}`);
      if (executed && this.cfg.dryRun) lines.push("DRY RUN: nothing sent");
      if (tx) lines.push(`tx: ${txUrl(this.cfg, tx)}`);
      await this.notify.send(lines.join("\n"));
    }
  }

  /** Current entry blocks without touching guard state. */
  entryBlocks(): string[] {
    if (!this.lastSnap) return ["no account data yet"];
    const d = evaluateGuard(this.lastSnap, this.rules, this.guardCtx(this.store.openPosition(), this.watcher.ageMs), this.guardState);
    return d.blocks;
  }

  // ---------- commands ----------

  setRules(rules: GuardRules): number {
    this.rules = rules;
    this.rulesVersion = this.store.saveGuardRules(rules, Date.now());
    this.guardState = initialGuardState();
    return this.rulesVersion;
  }

  setStrategy(params: StrategyParams, armed: boolean, paused: boolean): number {
    const version = this.store.saveStrategy(params, armed, paused, Date.now());
    this.strategy = { params, version, armed, paused };
    return version;
  }

  snoozeTrims(minutes = 15): void {
    this.guardState = snooze(this.guardState, Date.now() + minutes * 60_000);
  }

  async manualClose(pct: number, kind: "manual-close" | "panic"): Promise<ExecResult | null> {
    const p = this.lastSnap?.position;
    if (!p) return null;
    this.ownActionUntil = Date.now() + 30_000;
    const s = this.cfg.slippageBps;
    return this.exec.reduce({ fraction: pct / 100, kind, reason: `user ${kind === "panic" ? "/panic" : `/close ${pct}`}`, side: p.side, mark: p.mark, slippages: pct >= 100 ? [s, s * 2, s * 4] : [s, s * 2] });
  }

  async panic(): Promise<{ close: ExecResult | null; cancelled: number }> {
    const view = await this.c.exchange.client.accountPositions.getSnapshot(this.c.market.info.marginBank, this.c.owner);
    const pool = this.c.market.info.poolAddress.toLowerCase();
    const orders = view.data.orders.status === "known" ? view.data.orders.value.filter((o) => o.pool.toLowerCase() === pool).map((o) => o.orderId) : [];
    await this.exec.cancelOrders(orders);
    const close = await this.manualClose(100, "panic");
    return { close, cancelled: orders.length };
  }

  statusText(): string {
    const s = this.lastSnap;
    const lines: string[] = [];
    const meta = this.store.openPosition();
    if (!s) lines.push("No account data yet.");
    else if (!s.position) lines.push(`No BTC-PERP position. Equity ${usd(s.equity)}.`);
    else {
      const p = s.position;
      lines.push(`📈 ${p.side.toUpperCase()} ${btc(p.size)} BTC @ ${px(p.entry)} (${meta?.origin ?? "?"}) · mark ${px(p.mark)} · uPnL ${usd(p.unrealizedPnl)}`);
      lines.push(`Health ${hx(health(s))} · equity ${usd(s.equity)} · maint. ${usd(s.mmReq)} · liq ${px(p.liqPrice ?? triggerPrice(s, 1))}`);
      lines.push(this.triggerLines(s));
      if (meta?.origin === "strategy") lines.push(`Bot-side TP ${px(meta.tp_px)} · SL ${px(meta.sl_px)}`);
    }
    lines.push(`🛡️ Guard: ${this.rules.enabled ? "ON" : "OFF"} · ${this.rules.profile} · ${this.rules.mode} · v${this.rulesVersion}${this.guardState.snoozedUntil && Date.now() < this.guardState.snoozedUntil ? " · trims snoozed" : ""}`);
    const st = this.strategy;
    lines.push(st ? `🤖 Strategy: ${st.params.preset} v${st.version} · ${st.armed ? (st.paused ? "paused" : "armed") : "not armed"}` : "🤖 Strategy: not set (/strategy)");
    const last = this.store.lastDecision();
    if (last) lines.push(`Last candle ${watTime(last.candle_ts + 900_000)}: ${last.preset} → ${last.intent} (${last.reason})`);
    const blocks = this.entryBlocks();
    lines.push(blocks.length ? `⛔ Entries blocked: ${blocks.join("; ")}` : "✅ Entries allowed");
    lines.push(`Data: source ${this.watcher.source} · ${this.watcher.updatesPerMin} updates/min · last ${Number.isFinite(this.watcher.ageMs) ? `${(this.watcher.ageMs / 1000).toFixed(1)} s` : "never"} ago · ATR(15m) ${this.atr?.toFixed(2) ?? "n/a"}%`);
    lines.push(`Bot gas ${this.stt?.toFixed(3) ?? "n/a"} STT · link ${this.link.ok ? "OK" : "MISSING"} · ${this.cfg.dryRun ? "DRY RUN" : "LIVE"}`);
    return lines.join("\n");
  }

  private scheduleRecap(): void {
    const now = Date.now();
    const nextMidnightWat = Math.ceil((now + 3_600_000) / 86_400_000) * 86_400_000 - 3_600_000;
    const t = setTimeout(async () => {
      const day = this.store.day(dayWat(Date.now() - 60_000));
      await this.notify.send(`📊 Daily recap: ${day.guard_saves} guard saves · ${day.trades} strategy trades · realized ${usd(day.realized_pnl)}`);
      this.scheduleRecap();
    }, nextMidnightWat - now + 5_000);
    this.timers.push(t);
  }
}
