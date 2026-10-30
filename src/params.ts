import { z } from "zod";
import { hashOf } from "./rules.js";

export const PRESETS = ["breakout", "trend"] as const;
export type Preset = (typeof PRESETS)[number];

export const CHOICES = {
  sizeUsd: [10, 25, 50, 100],
  leverage: [2, 3, 5],
  tpPct: [0.5, 1, 1.5, 2, 3],
  slPct: [0.3, 0.5, 0.75, 1, 1.5],
  maxTradesPerDay: [1, 3, 5, 10],
  dailyLossLimitUsd: [5, 10, 25, 50],
  direction: ["both", "long", "short"],
} as const;

const BaseParams = z.object({
  preset: z.enum(PRESETS),
  /** Notional per trade, USDso. */
  sizeUsd: z.number().min(5),
  /** Max effective account leverage (total BTC notional / equity) after the entry. */
  leverage: z.union([z.literal(2), z.literal(3), z.literal(5)]),
  tpPct: z.number().positive().max(20),
  slPct: z.number().positive().max(20),
  maxTradesPerDay: z.number().int().min(1).max(50),
  dailyLossLimitUsd: z.number().positive(),
  direction: z.enum(["both", "long", "short"]),
  breakout: z.object({ lookbackH: z.literal(1), bufferPct: z.number().min(0).max(2) }),
  trend: z.object({ fast: z.number().int().min(2), slow: z.number().int().min(3) }),
});

export type StrategyParams = z.infer<typeof BaseParams>;

export function defaultParams(preset: Preset): StrategyParams {
  return {
    preset,
    sizeUsd: 25,
    leverage: 3,
    tpPct: 1,
    slPct: 0.5,
    maxTradesPerDay: 3,
    dailyLossLimitUsd: 10,
    direction: "both",
    breakout: { lookbackH: 1, bufferPct: 0.05 },
    trend: { fast: 9, slow: 21 },
  };
}

/** Schema + cross-field rules; `maxOrderUsd` comes from the deployment's hard cap. */
export function validateParams(input: unknown, maxOrderUsd: number): StrategyParams {
  const parsed = BaseParams.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const p = parsed.data;
  const errors: string[] = [];
  const slCap = (100 / p.leverage) * 0.5;
  if (p.slPct >= slCap) errors.push(`slPct ${p.slPct}% must be below ${slCap.toFixed(1)}% at ${p.leverage}x so the stop fires well before liquidation`);
  if (p.sizeUsd > maxOrderUsd) errors.push(`sizeUsd ${p.sizeUsd} exceeds MAX_ORDER_USD ${maxOrderUsd}`);
  if (p.trend.fast >= p.trend.slow) errors.push("trend.fast must be shorter than trend.slow");
  if (errors.length) throw new Error(errors.join("; "));
  return p;
}

export interface DerivedRisk {
  marginUsd: number;
  liqDistancePct: number;
  worstLossPerTradeUsd: number;
  dailyCapUsd: number;
}

/** What the confirm card shows. Liq distance ≈ 1/lev − MM (2.5%) for an account at exactly that leverage. */
export function derivedRisk(p: StrategyParams, mmRate = 0.025): DerivedRisk {
  return {
    marginUsd: p.sizeUsd / p.leverage,
    liqDistancePct: Math.max(0, (1 / p.leverage - mmRate) * 100),
    worstLossPerTradeUsd: (p.sizeUsd * p.slPct) / 100,
    dailyCapUsd: p.dailyLossLimitUsd,
  };
}

export const paramsHash = (p: StrategyParams) => hashOf(p);
