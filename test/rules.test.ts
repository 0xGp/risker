import { describe, expect, it } from "vitest";
import { GUARD_PROFILES, makeRules, rulesHash, updateRules } from "../src/rules.js";

describe("guard rules", () => {
  it.each(GUARD_PROFILES)("profile %s is valid", (p) => {
    expect(makeRules(p).profile).toBe(p);
  });

  it("rejects inverted or crowded thresholds", () => {
    const r = makeRules("balanced");
    expect(() => updateRules(r, { flattenHealth: 1.0 })).toThrow(/1.05/);
    expect(() => updateRules(r, { trimHealth: 1.2 })).toThrow(/trim/);
    expect(() => updateRules(r, { warnHealth: 1.6 })).toThrow(/warn/);
    expect(() => updateRules(r, { atrFlattenMult: 5 })).toThrow(/ATR/);
    expect(updateRules(r, { trimHealth: 1.6 }).trimHealth).toBe(1.6);
  });

  it("hashes canonically: key order does not matter", () => {
    const r = makeRules("aggressive");
    const reordered = Object.fromEntries(Object.entries(r).reverse()) as typeof r;
    expect(rulesHash(reordered)).toBe(rulesHash(r));
    expect(rulesHash(makeRules("balanced"))).not.toBe(rulesHash(r));
  });
});
