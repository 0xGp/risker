import type { GuardContext } from "../src/guard/engine.js";
import type { Candle, GuardSnapshot, Side } from "../src/types.js";

/** Tunde's 15x long: $200 equity, $3,000 notional at 80,500, MM 2.5%. */
export function tunde(over: Partial<GuardSnapshot> = {}): GuardSnapshot {
  const size = 3000 / 80500;
  return {
    block: 1000,
    observedAtMs: 1_000_000,
    equity: 200,
    mmReq: 75,
    position: { side: "long", size, entry: 80500, mark: 80500, liqPrice: null, notional: 3000, mm: 75, unrealizedPnl: 0 },
    ...over,
  };
}

/** A snapshot whose health is exactly `h`, with no ATR-relevant liq price. */
export function atHealth(h: number, opts: { block?: number; t?: number; side?: Side; mark?: number } = {}): GuardSnapshot {
  const mark = opts.mark ?? 80000;
  const size = 0.05;
  const mm = size * mark * 0.025;
  return {
    block: opts.block ?? 1,
    observedAtMs: opts.t ?? 0,
    equity: h * mm,
    mmReq: mm,
    position: { side: opts.side ?? "long", size, entry: mark, mark, liqPrice: null, notional: size * mark, mm, unrealizedPnl: 0 },
  };
}

export function ctx(over: Partial<GuardContext> = {}): GuardContext {
  return { origin: "manual", tpPx: null, slPx: null, atrPct: null, dataAgeMs: 1000, botStt: 1, linkOk: true, dailyBlock: null, ...over };
}

export function candle(ts: number, close: number, spread = 10): Candle {
  return { ts, open: close, high: close + spread, low: close - spread, close, volume: 1 };
}

/** `n` 15m candles from t0 with the given closes. */
export function series(t0: number, closes: number[], spread = 10): Candle[] {
  return closes.map((c, i) => candle(t0 + i * 900_000, c, spread));
}
