import { describe, expect, it } from "vitest";
import { distToLiqPct, health, healthAfterTrim, healthAt, triggerPrice, triggers } from "../src/guard/trigger.js";
import { tunde } from "./fixtures.js";

describe("trigger prices", () => {
  it("Tunde's 15x long: health 2.67 and liquidation near 77,060", () => {
    const s = tunde();
    expect(health(s)).toBeCloseTo(2.667, 2);
    expect(triggerPrice(s, 1)).toBeCloseTo(77061, -1);
  });

  it.each([1, 1.15, 1.5, 2, 2.5])("long: health at triggerPrice(h=%s) round-trips to h", (h) => {
    const s = tunde();
    const p = triggerPrice(s, h)!;
    expect(p).toBeLessThan(80500);
    expect(healthAt(s, p)).toBeCloseTo(h, 6);
  });

  it.each([1, 1.15, 1.5, 2])("short: trigger is above the mark and round-trips (h=%s)", (h) => {
    const base = tunde();
    const s = { ...base, position: { ...base.position!, side: "short" as const } };
    const p = triggerPrice(s, h)!;
    expect(p).toBeGreaterThan(80500);
    expect(healthAt(s, p)).toBeCloseTo(h, 6);
  });

  it("counts other markets' maintenance in the account requirement", () => {
    const base = tunde();
    const withOther = { ...base, mmReq: 100 };
    expect(triggerPrice(withOther, 1)!).toBeGreaterThan(triggerPrice(base, 1)!);
    expect(healthAt(withOther, triggerPrice(withOther, 1.5)!)).toBeCloseTo(1.5, 6);
  });

  it("returns null when no positive price reaches the level", () => {
    const s = tunde({ equity: 100_000 });
    expect(triggerPrice(s, 1)).toBeNull();
    expect(triggerPrice(tunde({ position: null }), 1)).toBeNull();
  });

  it("trimming 25% at health 1.5 lifts health to 2.0; 50% doubles it", () => {
    const s = tunde({ equity: 112.5 });
    expect(health(s)).toBeCloseTo(1.5, 6);
    expect(healthAfterTrim(s, 0.25)).toBeCloseTo(2.0, 6);
    expect(healthAfterTrim(s, 0.5)).toBeCloseTo(3.0, 6);
  });

  it("matches the chain's own liquidation price on a live Hideki account (block 37341175)", () => {
    const s = {
      block: 37341175,
      observedAtMs: 0,
      equity: 1088.65,
      mmReq: 472.42,
      position: { side: "long" as const, size: 0.2471, entry: 82010, mark: 76473.9125, liqPrice: null, notional: 18896.7, mm: 472.42, unrealizedPnl: 0 },
    };
    expect(health(s)).toBeCloseTo(2.304, 2);
    expect(triggerPrice(s, 1)).toBeCloseTo(73916.1, -1);
  });

  it("prefers the chain's liquidation price for the distance when present", () => {
    const base = tunde();
    const s = { ...base, position: { ...base.position!, liqPrice: 78_890 } };
    expect(distToLiqPct(s)).toBeCloseTo(2, 3);
    expect(triggers(s, { warnHealth: 2, trimHealth: 1.5, flattenHealth: 1.15 }).liq).toBe(78_890);
  });
});
