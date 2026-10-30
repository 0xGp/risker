import type { GuardDecision } from "./guard/engine.js";
import type { Decision } from "./strategy/engine.js";
import type { Origin } from "./types.js";

export type Arbitrated =
  | { source: "guard"; decision: GuardDecision }
  | { source: "strategy"; decision: Decision }
  | { source: "none"; reason: string };

/**
 * The guard outranks the strategy. A guard action wins outright; a strategy entry is dropped
 * while any block is active; the strategy never closes a position it did not open.
 */
export function arbitrate(guard: GuardDecision | null, strategy: Decision | null, origin: Origin | null, strategyPaused: boolean): Arbitrated {
  if (guard?.action) return { source: "guard", decision: guard };
  if (!strategy || strategy.intent.kind === "none") return { source: "none", reason: strategy?.reason ?? "no strategy decision" };
  if (strategyPaused) return { source: "none", reason: `strategy paused (${strategy.reason})` };
  if (strategy.intent.kind === "close") {
    if (origin !== "strategy") return { source: "none", reason: "strategy never closes a manual position" };
    return { source: "strategy", decision: strategy };
  }
  if (origin !== null) return { source: "none", reason: "a position is already open" };
  const blocks = guard?.blocks ?? [];
  if (blocks.length) return { source: "none", reason: `entry blocked by guard: ${blocks.join("; ")}` };
  return { source: "strategy", decision: strategy };
}
