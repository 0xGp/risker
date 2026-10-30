import type { SomniaMarkets } from "@somnia-chain/markets-sdk";
import type { Candle } from "./types.js";

export const M15 = 900_000;
export const H1 = 3_600_000;
const SETTLE_MS = 20_000;
const SYMBOL = "BTC/USDso:USDso";

/** Keep only candles closed by `nowMs`, deduped by ts, ascending. The newest bucket may still be open. */
export function closedOnly(rows: Candle[], tfMs: number, nowMs: number): Candle[] {
  const byTs = new Map<number, Candle>();
  for (const c of rows) if (c.ts + tfMs <= nowMs) byTs.set(c.ts, c);
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

export async function fetchClosed(exchange: SomniaMarkets, tf: "15m" | "1h", limit: number, nowMs = Date.now()): Promise<Candle[]> {
  const tfMs = tf === "15m" ? M15 : H1;
  const rows = await exchange.fetchOHLCV(SYMBOL, tf, undefined, limit);
  const candles = rows.map((r) => ({ ts: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }));
  return closedOnly(candles, tfMs, nowMs);
}

/** Next :00/:15/:30/:45 boundary after `nowMs`, plus the settle delay. */
export function nextFire(nowMs: number): number {
  return Math.floor(nowMs / M15) * M15 + M15 + SETTLE_MS;
}

export interface CandleBatch {
  closed15m: Candle[];
  hourly: Candle[];
  /** The 15m candle that just closed. */
  expectedTs: number;
}

/**
 * Fires at each quarter hour + 20 s. Re-fetches every 10 s while the just-closed candle is missing
 * from the indexer, and skips (with a log line) after 60 s. A missed candle is never back-traded.
 */
export class CandleClock {
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly exchange: SomniaMarkets,
    private readonly onBatch: (b: CandleBatch) => Promise<void>,
    private readonly log: (msg: string) => void = console.log,
  ) {}

  start(): void {
    this.schedule();
  }

  close(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  async load(nowMs = Date.now()): Promise<CandleBatch> {
    const [closed15m, hourly] = await Promise.all([fetchClosed(this.exchange, "15m", 120, nowMs), fetchClosed(this.exchange, "1h", 48, nowMs)]);
    return { closed15m, hourly, expectedTs: Math.floor(nowMs / M15) * M15 - M15 };
  }

  private schedule(): void {
    if (this.stopped) return;
    const delay = Math.max(1_000, nextFire(Date.now()) - Date.now());
    this.timer = setTimeout(() => void this.fire(), delay);
  }

  private async fire(): Promise<void> {
    const started = Date.now();
    const expectedTs = Math.floor((started - SETTLE_MS) / M15) * M15 - M15;
    try {
      for (;;) {
        const batch = await this.load();
        if (batch.closed15m.at(-1)?.ts === expectedTs) {
          await this.onBatch({ ...batch, expectedTs });
          break;
        }
        if (Date.now() - started > 60_000) {
          this.log(`candle ${new Date(expectedTs).toISOString()} still missing from the indexer after 60 s: skipped`);
          break;
        }
        await new Promise((r) => setTimeout(r, 10_000));
      }
    } catch (err) {
      this.log(`candle fetch failed: ${(err as Error).message}`);
    }
    this.schedule();
  }
}
