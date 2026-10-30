import { describe, expect, it } from "vitest";
import { arbitrate } from "../src/arbiter.js";
import { evaluateGuard, initialGuardState } from "../src/guard/engine.js";
import { defaultParams, derivedRisk, validateParams } from "../src/params.js";
import { makeRules } from "../src/rules.js";
import { bracket, decide, WARMUP_CANDLES, type Decision } from "../src/strategy/engine.js";
import { atrPct, ema } from "../src/strategy/indicators.js";
import { atHealth, candle, ctx, series } from "./fixtures.js";

const T0 = Date.UTC(2026, 9, 30, 0, 0);
const day = { trades: 0, pnlUsd: 0 };

function hourlyFrom(c15: ReturnType<typeof series>) {
  const out = [];
  for (let i = 0; i + 4 <= c15.length; i += 4) {
    const chunk = c15.slice(i, i + 4);
    out.push({ ts: chunk[0]!.ts, open: chunk[0]!.open, high: Math.max(...chunk.map((c) => c.high)), low: Math.min(...chunk.map((c) => c.low)), close: chunk[3]!.close, volume: 4 });
  }
  return out;
}

describe("indicators", () => {
  it("EMA seeds with the SMA", () => {
    expect(ema([1, 2, 3, 4], 3)).toEqual([NaN, NaN, 2, 3]);
  });
  it("ATR% of a constant-range series equals range / close", () => {
    expect(atrPct(series(T0, Array(20).fill(80_000), 40))).toBeCloseTo((80 / 80_000) * 100, 6);
  });
});

describe("breakout preset", () => {
  const p = defaultParams("breakout");
  const flat = series(T0, Array(32).fill(80_000));
  const hourly = hourlyFrom(flat);

  it("waits for warm-up", () => {
    expect(decide(flat.slice(0, WARMUP_CANDLES - 1), hourly, null, p, day).intent.kind).toBe("none");
  });

  it("goes long when the close clears the prior 1h high + buffer", () => {
    const up = [...flat, candle(T0 + 32 * 900_000, 80_060)];
    const d = decide(up, hourly, null, p, day);
    expect(d.intent).toEqual({ kind: "open", side: "long" });
    expect(d.reason).toContain("1h high");
  });

  it("goes short below the prior 1h low − buffer, and stays flat inside the range", () => {
    expect(decide([...flat, candle(T0 + 32 * 900_000, 79_940)], hourly, null, p, day).intent).toEqual({ kind: "open", side: "short" });
    expect(decide([...flat, candle(T0 + 32 * 900_000, 80_005)], hourly, null, p, day).intent.kind).toBe("none");
  });

  it("only uses 1h candles completed before the 15m candle closed", () => {
    const up = [...flat, candle(T0 + 32 * 900_000, 80_060)];
    const leaky = [...hourly, { ts: T0 + 32 * 900_000, open: 80_000, high: 90_000, low: 79_000, close: 80_060, volume: 1 }];
    expect(decide(up, leaky, null, p, day).intent).toEqual({ kind: "open", side: "long" });
  });

  it("respects direction, max trades/day and the daily loss limit", () => {
    const up = [...flat, candle(T0 + 32 * 900_000, 80_060)];
    expect(decide(up, hourly, null, { ...p, direction: "short" }, day).intent.kind).toBe("none");
    expect(decide(up, hourly, null, p, { trades: 3, pnlUsd: 0 }).intent.kind).toBe("none");
    expect(decide(up, hourly, null, p, { trades: 0, pnlUsd: -10 }).intent.kind).toBe("none");
  });

  it("stands aside for a manual position and closes its own on an opposite signal", () => {
    const down = [...flat, candle(T0 + 32 * 900_000, 79_900)];
    expect(decide(down, hourly, { side: "long", origin: "manual" }, p, day).intent.kind).toBe("none");
    expect(decide(down, hourly, { side: "long", origin: "strategy" }, p, day).intent.kind).toBe("close");
    expect(decide(down, hourly, { side: "short", origin: "strategy" }, p, day).intent.kind).toBe("none");
  });
});

describe("trend preset", () => {
  const p = defaultParams("trend");
  const closes = [...Array.from({ length: 30 }, (_, i) => 81_000 - i * 20), ...Array.from({ length: 30 }, (_, i) => 80_420 + i * 40)];
  const all = series(T0, closes);
  const crossAt = (() => {
    for (let n = WARMUP_CANDLES; n <= all.length; n++) if (decide(all.slice(0, n), [], null, p, day).intent.kind === "open") return n;
    return -1;
  })();

  it("goes long on the candle where EMA9 crosses above EMA21, not before", () => {
    expect(crossAt).toBeGreaterThan(WARMUP_CANDLES);
    expect(decide(all.slice(0, crossAt), [], null, p, day).intent).toEqual({ kind: "open", side: "long" });
    expect(decide(all.slice(0, crossAt - 1), [], null, p, day).intent.kind).toBe("none");
    expect(decide(all.slice(0, crossAt + 1), [], null, p, day).intent.kind).toBe("none");
  });

  it("is deterministic: same input twice, same decision", () => {
    const a: Decision = decide(all.slice(0, crossAt), [], null, p, day);
    const b: Decision = decide(all.slice(0, crossAt), [], null, p, day);
    expect(a).toEqual(b);
    expect(a.candleTs).toBe(all[crossAt - 1]!.ts);
  });

  it("brackets TP/SL from the entry", () => {
    const long = bracket("long", 80_000, p);
    const short = bracket("short", 80_000, p);
    expect(long.tp).toBeCloseTo(80_800, 6);
    expect(long.sl).toBeCloseTo(79_600, 6);
    expect(short.tp).toBeCloseTo(79_200, 6);
    expect(short.sl).toBeCloseTo(80_400, 6);
  });
});

describe("params validator", () => {
  it("accepts the defaults and derives the risk", () => {
    const p = validateParams(defaultParams("breakout"), 100);
    expect(derivedRisk(p)).toEqual({ marginUsd: 25 / 3, liqDistancePct: (1 / 3 - 0.025) * 100, worstLossPerTradeUsd: 0.125, dailyCapUsd: 10 });
  });
  it("rejects a stop too close to liquidation, a size over the cap, and bad EMAs", () => {
    expect(() => validateParams({ ...defaultParams("breakout"), leverage: 5, slPct: 10 }, 100)).toThrow(/slPct/);
    expect(() => validateParams({ ...defaultParams("breakout"), sizeUsd: 150 }, 100)).toThrow(/MAX_ORDER_USD/);
    expect(() => validateParams({ ...defaultParams("trend"), trend: { fast: 21, slow: 9 } }, 100)).toThrow(/fast/);
    expect(() => validateParams({ ...defaultParams("trend"), preset: "meanrevert" }, 100)).toThrow();
  });
});

describe("arbiter", () => {
  const rules = makeRules("balanced");
  const open: Decision = { intent: { kind: "open", side: "long" }, reason: "x", candleTs: 1 };
  const close: Decision = { intent: { kind: "close" }, reason: "x", candleTs: 1 };

  it("a guard action outranks any strategy intent", () => {
    const g = evaluateGuard(atHealth(1.1), rules, ctx(), initialGuardState());
    expect(arbitrate(g, close, "strategy", false).source).toBe("guard");
  });
  it("drops entries while the guard blocks", () => {
    const g = evaluateGuard({ ...atHealth(5), position: null }, rules, ctx({ dailyBlock: "daily loss limit reached" }), initialGuardState());
    expect(arbitrate(g, open, null, false)).toMatchObject({ source: "none", reason: expect.stringContaining("daily loss") });
  });
  it("never lets the strategy close a manual position", () => {
    expect(arbitrate(null, close, "manual", false).source).toBe("none");
    expect(arbitrate(null, close, "strategy", false).source).toBe("strategy");
  });
  it("respects pause and an open position", () => {
    expect(arbitrate(null, open, null, true).source).toBe("none");
    expect(arbitrate(null, open, "manual", false).source).toBe("none");
    expect(arbitrate(null, open, null, false).source).toBe("strategy");
  });
});
