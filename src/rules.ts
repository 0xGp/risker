import { createHash } from "node:crypto";
import { z } from "zod";

export const GUARD_PROFILES = ["conservative", "balanced", "aggressive"] as const;
export type GuardProfile = (typeof GUARD_PROFILES)[number];
export type GuardMode = "alert" | "protect";

export const PROFILE_DEFAULTS: Record<
  GuardProfile,
  { warnHealth: number; trimHealth: number; flattenHealth: number; trimPct: 25 | 50; atrTrimMult: number; atrFlattenMult: number }
> = {
  conservative: { warnHealth: 2.5, trimHealth: 1.8, flattenHealth: 1.3, trimPct: 50, atrTrimMult: 3, atrFlattenMult: 1.5 },
  balanced: { warnHealth: 2.0, trimHealth: 1.5, flattenHealth: 1.15, trimPct: 25, atrTrimMult: 2, atrFlattenMult: 1 },
  aggressive: { warnHealth: 1.6, trimHealth: 1.3, flattenHealth: 1.1, trimPct: 25, atrTrimMult: 1.5, atrFlattenMult: 0.75 },
};

export const GuardRulesSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(["alert", "protect"]),
    profile: z.enum(GUARD_PROFILES),
    warnHealth: z.number().finite(),
    trimHealth: z.number().finite(),
    flattenHealth: z.number().finite(),
    trimPct: z.union([z.literal(25), z.literal(50)]),
    atrTrimMult: z.number().min(0).max(10),
    atrFlattenMult: z.number().min(0).max(10),
  })
  .superRefine((r, ctx) => {
    const gap = 0.2 - 1e-9;
    if (r.flattenHealth < 1.05) ctx.addIssue({ code: "custom", path: ["flattenHealth"], message: "flatten must be ≥ 1.05 (1.0 is liquidation)" });
    if (r.trimHealth - r.flattenHealth < gap) ctx.addIssue({ code: "custom", path: ["trimHealth"], message: "trim must be at least 0.2 above flatten" });
    if (r.warnHealth - r.trimHealth < gap) ctx.addIssue({ code: "custom", path: ["warnHealth"], message: "warn must be at least 0.2 above trim" });
    if (r.atrFlattenMult > r.atrTrimMult) ctx.addIssue({ code: "custom", path: ["atrFlattenMult"], message: "the flatten ATR buffer must not exceed the trim one" });
  });

export type GuardRules = z.infer<typeof GuardRulesSchema>;

export function makeRules(profile: GuardProfile, mode: GuardMode = "protect", enabled = true): GuardRules {
  return GuardRulesSchema.parse({ enabled, mode, profile, ...PROFILE_DEFAULTS[profile] });
}

/** Validate a partial edit on top of existing rules; throws a readable message. */
export function updateRules(current: GuardRules, patch: Partial<GuardRules>): GuardRules {
  const res = GuardRulesSchema.safeParse({ ...current, ...patch });
  if (!res.success) throw new Error(res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return res.data;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 12);
}

export const rulesHash = (r: GuardRules) => hashOf(r);
