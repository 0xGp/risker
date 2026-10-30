import { describe, expect, it } from "vitest";
import { evaluateGuard, initialGuardState, MAX_ACTIONS_PER_HOUR, rearm, snooze, type GuardState } from "../src/guard/engine.js";
import { GUARD_PROFILES, makeRules, PROFILE_DEFAULTS } from "../src/rules.js";
import { atHealth, ctx } from "./fixtures.js";

const balanced = makeRules("balanced", "protect");
const eps = 1e-6;

describe("guard thresholds per profile (protect mode)", () => {
  for (const profile of GUARD_PROFILES) {
    const r = makeRules(profile, "protect");
    const d = PROFILE_DEFAULTS[profile];

    it(`${profile}: exactly at trim ${d.trimHealth} does nothing; just below trims ${d.trimPct}%`, () => {
      expect(evaluateGuard(atHealth(d.trimHealth), r, ctx(), initialGuardState()).action).toBeNull();
      const below = evaluateGuard(atHealth(d.trimHealth - eps), r, ctx(), initialGuardState());
      expect(below.action).toMatchObject({ level: "trim", fraction: d.trimPct / 100 });
    });

    it(`${profile}: exactly at flatten ${d.flattenHealth} trims; just below flattens`, () => {
      expect(evaluateGuard(atHealth(d.flattenHealth), r, ctx(), initialGuardState()).action?.level).toBe("trim");
      expect(evaluateGuard(atHealth(d.flattenHealth - eps), r, ctx(), initialGuardState()).action).toMatchObject({ level: "flatten", fraction: 1 });
    });

    it(`${profile}: exactly at warn ${d.warnHealth} is quiet; just below warns and blocks entries`, () => {
      const at = evaluateGuard(atHealth(d.warnHealth), r, ctx(), initialGuardState());
      expect(at.alert).toBeNull();
      expect(at.blocks).toEqual([]);
      const below = evaluateGuard(atHealth(d.warnHealth - eps), r, ctx(), initialGuardState());
      expect(below.action).toBeNull();
      expect(below.alert?.level).toBe("warn");
      expect(below.blocks.some((b) => b.includes("warn"))).toBe(true);
    });
  }
});

describe("guard behaviour", () => {
  it("alert mode suggests instead of acting", () => {
    const r = makeRules("balanced", "alert");
    expect(evaluateGuard(atHealth(1.4), r, ctx(), initialGuardState())).toMatchObject({ action: null, alert: { level: "suggest-trim" } });
    expect(evaluateGuard(atHealth(1.1), r, ctx(), initialGuardState())).toMatchObject({ action: null, alert: { level: "suggest-flatten" } });
  });

  it("disabled guard never acts", () => {
    const r = makeRules("balanced", "protect", false);
    expect(evaluateGuard(atHealth(1.01), r, ctx(), initialGuardState()).action).toBeNull();
  });

  it("hysteresis: trim fires once, re-arms only above trim + 0.1", () => {
    let st = evaluateGuard(atHealth(1.45, { block: 1, t: 0 }), balanced, ctx(), initialGuardState()).state;
    expect(st.armed.trim).toBe(false);
    let d = evaluateGuard(atHealth(1.55, { block: 2, t: 60_000 }), balanced, ctx(), st);
    expect(d.state.armed.trim).toBe(false);
    d = evaluateGuard(atHealth(1.45, { block: 3, t: 120_000 }), balanced, ctx(), d.state);
    expect(d.action).toBeNull();
    d = evaluateGuard(atHealth(1.61, { block: 4, t: 180_000 }), balanced, ctx(), d.state);
    expect(d.state.armed.trim).toBe(true);
    d = evaluateGuard(atHealth(1.49, { block: 5, t: 240_000 }), balanced, ctx(), d.state);
    expect(d.action?.level).toBe("trim");
    st = d.state;
    expect(st.actionTimes).toHaveLength(2);
  });

  it("idempotency: one block never acts twice, even after a re-arm", () => {
    const first = evaluateGuard(atHealth(1.1, { block: 7, t: 0 }), balanced, ctx(), initialGuardState());
    expect(first.action?.key).toBe("flatten:7");
    const again = evaluateGuard(atHealth(1.1, { block: 7, t: 10_000 }), balanced, ctx(), { ...first.state, armed: { ...first.state.armed, flatten: true } });
    expect(again.action).toBeNull();
  });

  it("cooldown: a failed flatten re-armed retries after 3 s, not before", () => {
    const first = evaluateGuard(atHealth(1.1, { block: 1, t: 0 }), balanced, ctx(), initialGuardState());
    const st = rearm(first.state, "flatten");
    expect(evaluateGuard(atHealth(1.1, { block: 2, t: 2_000 }), balanced, ctx(), st).action).toBeNull();
    expect(evaluateGuard(atHealth(1.1, { block: 3, t: 3_000 }), balanced, ctx(), st).action?.level).toBe("flatten");
  });

  it(`caps automatic actions at ${MAX_ACTIONS_PER_HOUR}/hour, then alerts once`, () => {
    let st: GuardState = { ...initialGuardState(), actionTimes: Array.from({ length: MAX_ACTIONS_PER_HOUR }, (_, i) => i * 1000) };
    const d = evaluateGuard(atHealth(1.4, { block: 9, t: 600_000 }), balanced, ctx(), st);
    expect(d.action).toBeNull();
    expect(d.alert?.level).toBe("rate-limited");
    st = rearm(d.state, "trim");
    expect(evaluateGuard(atHealth(1.4, { block: 10, t: 700_000 }), balanced, ctx(), st).alert).toBeNull();
    const later = evaluateGuard(atHealth(1.4, { block: 11, t: 3_700_000 }), balanced, ctx(), st);
    expect(later.action?.level).toBe("trim");
  });

  it("snooze suppresses trims but never flatten", () => {
    const st = snooze(initialGuardState(), 900_000);
    expect(evaluateGuard(atHealth(1.4, { t: 1000 }), balanced, ctx(), st).action).toBeNull();
    expect(evaluateGuard(atHealth(1.1, { t: 1000 }), balanced, ctx(), st).action?.level).toBe("flatten");
    expect(evaluateGuard(atHealth(1.4, { t: 900_001 }), balanced, ctx(), st).action?.level).toBe("trim");
  });

  it("warns once per dip", () => {
    const d1 = evaluateGuard(atHealth(1.9, { block: 1 }), balanced, ctx(), initialGuardState());
    expect(d1.alert?.level).toBe("warn");
    const d2 = evaluateGuard(atHealth(1.85, { block: 2 }), balanced, ctx(), d1.state);
    expect(d2.alert).toBeNull();
  });

  it("ATR buffer trims a healthy-looking position close to liquidation", () => {
    const s = atHealth(1.8);
    const near = { ...s, position: { ...s.position!, liqPrice: s.position!.mark * 0.99 } };
    const d = evaluateGuard(near, balanced, ctx({ atrPct: 0.6 }), initialGuardState());
    expect(d.action?.level).toBe("trim");
    expect(d.action?.reason).toContain("ATR");
  });

  it("SL/TP apply to strategy positions only", () => {
    const s = atHealth(5, { mark: 79_000 });
    expect(evaluateGuard(s, balanced, ctx({ origin: "strategy", slPx: 79_500, tpPx: 81_000 }), initialGuardState()).action?.level).toBe("sl");
    expect(evaluateGuard(s, balanced, ctx({ origin: "manual", slPx: 79_500, tpPx: 81_000 }), initialGuardState()).action).toBeNull();
    const up = atHealth(5, { mark: 81_100 });
    expect(evaluateGuard(up, balanced, ctx({ origin: "strategy", slPx: 79_500, tpPx: 81_000 }), initialGuardState()).action?.level).toBe("tp");
  });

  it("reports every entry block", () => {
    const d = evaluateGuard(atHealth(5), balanced, ctx({ dataAgeMs: 31_000, botStt: 0.01, linkOk: false, dailyBlock: "daily loss limit reached" }), initialGuardState());
    expect(d.blocks).toHaveLength(4);
  });

  it("no position re-arms every level and clears snooze", () => {
    const st: GuardState = { ...initialGuardState(), armed: { warn: false, trim: false, flatten: false }, snoozedUntil: 5 };
    const d = evaluateGuard({ ...atHealth(5), position: null }, balanced, ctx(), st);
    expect(d.state.armed).toEqual({ warn: true, trim: true, flatten: true });
    expect(d.state.snoozedUntil).toBeNull();
  });

  it("is deterministic and does not mutate its input state", () => {
    const st = initialGuardState();
    const frozen = JSON.stringify(st);
    const a = evaluateGuard(atHealth(1.4), balanced, ctx({ atrPct: 0.5 }), st);
    const b = evaluateGuard(atHealth(1.4), balanced, ctx({ atrPct: 0.5 }), st);
    expect(a).toEqual(b);
    expect(JSON.stringify(st)).toBe(frozen);
  });
});
