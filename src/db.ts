import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeRules, rulesHash, type GuardRules } from "./rules.js";
import { paramsHash, type StrategyParams } from "./params.js";
import type { Origin, Side } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS guard_rules (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, rules_json TEXT NOT NULL, rules_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS strategy_configs (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, params_json TEXT NOT NULL, params_hash TEXT NOT NULL, armed INTEGER NOT NULL, paused INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS day_state (day_wat TEXT PRIMARY KEY, trades INTEGER NOT NULL DEFAULT 0, realized_pnl REAL NOT NULL DEFAULT 0, guard_saves INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY, candle_ts INTEGER NOT NULL UNIQUE, preset TEXT, params_version INTEGER, params_hash TEXT, intent TEXT NOT NULL, reason TEXT NOT NULL, executed INTEGER NOT NULL DEFAULT 0, blocked_by TEXT, tx_hash TEXT, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS positions_meta (id INTEGER PRIMARY KEY, origin TEXT NOT NULL, side TEXT NOT NULL, qty REAL NOT NULL, entry_px REAL NOT NULL, tp_px REAL, sl_px REAL, opened_tx TEXT, opened_at INTEGER NOT NULL, closed_tx TEXT, closed_at INTEGER, pnl REAL);
CREATE TABLE IF NOT EXISTS guard_actions (id INTEGER PRIMARY KEY, level TEXT NOT NULL, mode TEXT NOT NULL, origin TEXT, health_before REAL, health_after REAL, liq_before REAL, liq_after REAL, mark REAL, qty REAL, tx_hash TEXT, status TEXT NOT NULL, reason TEXT, block INTEGER, rules_version INTEGER, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY, block INTEGER, mark REAL, liq_price REAL, equity REAL, mm_req REAL, health REAL, size REAL, source TEXT, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS txs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, side TEXT, qty REAL, price REAL, tx_hash TEXT, status TEXT NOT NULL, error TEXT, reason TEXT, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export interface PositionMeta {
  id: number;
  origin: Origin;
  side: Side;
  qty: number;
  entry_px: number;
  tp_px: number | null;
  sl_px: number | null;
  opened_tx: string | null;
  opened_at: number;
}

export interface TxRow {
  kind: string;
  side?: Side | null;
  qty?: number | null;
  price?: number | null;
  tx_hash?: string | null;
  status: "sent" | "filled" | "no-fill" | "failed" | "dry-run";
  error?: string | null;
  reason?: string | null;
  ts: number;
}

/** "YYYY-MM-DD" in West Africa Time (UTC+1), the day boundary for limits and recaps. */
export function dayWat(ms: number): string {
  return new Date(ms + 3_600_000).toISOString().slice(0, 10);
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  guardRules(): { rules: GuardRules; version: number } {
    const row = this.db.prepare("SELECT version, rules_json FROM guard_rules ORDER BY id DESC LIMIT 1").get() as { version: number; rules_json: string } | undefined;
    return row ? { rules: JSON.parse(row.rules_json), version: row.version } : { rules: makeRules("balanced", "protect"), version: 0 };
  }

  saveGuardRules(rules: GuardRules, now: number): number {
    const version = this.guardRules().version + 1;
    this.db.prepare("INSERT INTO guard_rules (version, rules_json, rules_hash, created_at) VALUES (?, ?, ?, ?)").run(version, JSON.stringify(rules), rulesHash(rules), now);
    return version;
  }

  strategy(): { params: StrategyParams; version: number; armed: boolean; paused: boolean } | null {
    const row = this.db.prepare("SELECT version, params_json, armed, paused FROM strategy_configs ORDER BY id DESC LIMIT 1").get() as
      | { version: number; params_json: string; armed: number; paused: number }
      | undefined;
    return row ? { params: JSON.parse(row.params_json), version: row.version, armed: !!row.armed, paused: !!row.paused } : null;
  }

  saveStrategy(params: StrategyParams, armed: boolean, paused: boolean, now: number): number {
    const prev = this.strategy();
    const same = prev && paramsHash(prev.params) === paramsHash(params);
    const version = same ? prev.version : (prev?.version ?? 0) + 1;
    this.db
      .prepare("INSERT INTO strategy_configs (version, params_json, params_hash, armed, paused, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(version, JSON.stringify(params), paramsHash(params), armed ? 1 : 0, paused ? 1 : 0, now);
    return version;
  }

  day(day: string): { trades: number; realized_pnl: number; guard_saves: number } {
    this.db.prepare("INSERT OR IGNORE INTO day_state (day_wat) VALUES (?)").run(day);
    return this.db.prepare("SELECT trades, realized_pnl, guard_saves FROM day_state WHERE day_wat = ?").get(day) as { trades: number; realized_pnl: number; guard_saves: number };
  }

  bumpDay(day: string, field: "trades" | "guard_saves", by = 1): void {
    this.day(day);
    this.db.prepare(`UPDATE day_state SET ${field} = ${field} + ? WHERE day_wat = ?`).run(by, day);
  }

  addRealized(day: string, pnl: number): void {
    this.day(day);
    this.db.prepare("UPDATE day_state SET realized_pnl = realized_pnl + ? WHERE day_wat = ?").run(pnl, day);
  }

  openPosition(): PositionMeta | null {
    return (this.db.prepare("SELECT * FROM positions_meta WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1").get() as PositionMeta | undefined) ?? null;
  }

  adopt(p: { origin: Origin; side: Side; qty: number; entry: number; tp?: number | null; sl?: number | null; tx?: string | null; now: number }): PositionMeta {
    this.db
      .prepare("INSERT INTO positions_meta (origin, side, qty, entry_px, tp_px, sl_px, opened_tx, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(p.origin, p.side, p.qty, p.entry, p.tp ?? null, p.sl ?? null, p.tx ?? null, p.now);
    return this.openPosition()!;
  }

  updatePosition(id: number, patch: { qty?: number; entry_px?: number; tp_px?: number | null; sl_px?: number | null }): void {
    const cur = this.db.prepare("SELECT * FROM positions_meta WHERE id = ?").get(id) as unknown as PositionMeta;
    const next = { ...cur, ...patch };
    this.db.prepare("UPDATE positions_meta SET qty = ?, entry_px = ?, tp_px = ?, sl_px = ? WHERE id = ?").run(next.qty, next.entry_px, next.tp_px, next.sl_px, id);
  }

  closePosition(id: number, now: number, pnl: number | null, tx: string | null): void {
    this.db.prepare("UPDATE positions_meta SET closed_at = ?, pnl = ?, closed_tx = ? WHERE id = ?").run(now, pnl, tx, id);
  }

  /** Returns false when this candle was already decided (unique candle_ts). */
  recordDecision(d: { candleTs: number; preset: string | null; paramsVersion: number | null; paramsHash: string | null; intent: string; reason: string; executed: boolean; blockedBy: string | null; tx: string | null; now: number }): boolean {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO decisions (candle_ts, preset, params_version, params_hash, intent, reason, executed, blocked_by, tx_hash, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(d.candleTs, d.preset, d.paramsVersion, d.paramsHash, d.intent, d.reason, d.executed ? 1 : 0, d.blockedBy, d.tx, d.now);
    return Number(res.changes) > 0;
  }

  decided(candleTs: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM decisions WHERE candle_ts = ?").get(candleTs);
  }

  lastDecision(): { candle_ts: number; preset: string | null; intent: string; reason: string } | null {
    return (this.db.prepare("SELECT candle_ts, preset, intent, reason FROM decisions ORDER BY candle_ts DESC LIMIT 1").get() as never) ?? null;
  }

  recordGuardAction(a: { level: string; mode: string; origin: string | null; healthBefore: number; healthAfter: number | null; liqBefore: number | null; liqAfter: number | null; mark: number | null; qty: number | null; tx: string | null; status: string; reason: string; block: number; rulesVersion: number; now: number }): void {
    this.db
      .prepare("INSERT INTO guard_actions (level, mode, origin, health_before, health_after, liq_before, liq_after, mark, qty, tx_hash, status, reason, block, rules_version, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(a.level, a.mode, a.origin, finite(a.healthBefore), finite(a.healthAfter), a.liqBefore, a.liqAfter, a.mark, a.qty, a.tx, a.status, a.reason, a.block, a.rulesVersion, a.now);
  }

  recordSnapshot(s: { block: number; mark: number | null; liq: number | null; equity: number; mmReq: number; health: number; size: number; source: string; now: number }): void {
    this.db
      .prepare("INSERT INTO snapshots (block, mark, liq_price, equity, mm_req, health, size, source, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(s.block, s.mark, s.liq, s.equity, s.mmReq, finite(s.health), s.size, s.source, s.now);
  }

  insertTx(t: TxRow): void {
    this.db
      .prepare("INSERT INTO txs (kind, side, qty, price, tx_hash, status, error, reason, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(t.kind, t.side ?? null, t.qty ?? null, t.price ?? null, t.tx_hash ?? null, t.status, t.error ?? null, t.reason ?? null, t.ts);
  }

  recentTxs(limit = 10): (TxRow & { id: number })[] {
    return this.db.prepare("SELECT * FROM txs ORDER BY id DESC LIMIT ?").all(limit) as never;
  }

  guardActions(limit = 1000): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM guard_actions ORDER BY id DESC LIMIT ?").all(limit) as never;
  }

  stats(): { txs: number; guardSaves: number; strategyTrades: number; realized: number } {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as { n: number | null }).n ?? 0);
    return {
      txs: one("SELECT COUNT(*) AS n FROM txs WHERE tx_hash IS NOT NULL"),
      guardSaves: one("SELECT COUNT(*) AS n FROM guard_actions WHERE level IN ('trim','flatten') AND tx_hash IS NOT NULL"),
      strategyTrades: one("SELECT COUNT(*) AS n FROM txs WHERE kind = 'strategy-open' AND tx_hash IS NOT NULL"),
      realized: one("SELECT SUM(pnl) AS n FROM positions_meta WHERE origin = 'strategy' AND pnl IS NOT NULL"),
    };
  }

  get(k: string): string | null {
    return ((this.db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined)?.v) ?? null;
  }

  set(k: string, v: string): void {
    this.db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }
}

function finite(n: number | null): number | null {
  return n === null || !Number.isFinite(n) ? null : n;
}
