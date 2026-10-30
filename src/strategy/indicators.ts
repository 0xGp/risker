import type { Candle } from "../types.js";

/** EMA seeded with the SMA of the first `period` values; entries before that are NaN. */
export function ema(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(Number.NaN);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder ATR over `period` candles, or null with too little data. */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prevClose = candles[i - 1]!.close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  let value = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) value = (value * (period - 1) + trs[i]!) / period;
  return value;
}

/** ATR as a % of the last close. */
export function atrPct(candles: Candle[], period = 14): number | null {
  const a = atr(candles, period);
  const last = candles.at(-1);
  return a === null || !last || last.close <= 0 ? null : (a / last.close) * 100;
}
