import type { GuardSnapshot } from "../types.js";

const DEFAULT_MM_RATE = 0.025;

export function health(s: Pick<GuardSnapshot, "equity" | "mmReq">): number {
  return s.mmReq > 0 ? s.equity / s.mmReq : Number.POSITIVE_INFINITY;
}

/** The position's maintenance rate and the rest of the account's requirement. */
function decompose(s: GuardSnapshot) {
  const p = s.position!;
  const mmRate = p.size > 0 && p.mark > 0 && p.mm > 0 ? p.mm / (p.size * p.mark) : DEFAULT_MM_RATE;
  const mmOther = Math.max(0, s.mmReq - p.mm);
  const q = p.side === "long" ? p.size : -p.size;
  return { p, mmRate, mmOther, q };
}

/**
 * Account health if BTC moved to `price` and nothing else changed.
 * equity(P) = E0 + q·(P − P0); mmReq(P) = mmRate·|q|·P + mmOther. Funding and fees are ignored.
 */
export function healthAt(s: GuardSnapshot, price: number): number {
  if (!s.position) return health(s);
  const { p, mmRate, mmOther, q } = decompose(s);
  const equity = s.equity + q * (price - p.mark);
  const mm = mmRate * Math.abs(q) * price + mmOther;
  return mm > 0 ? equity / mm : Number.POSITIVE_INFINITY;
}

/**
 * The BTC price at which account health equals `h` (h = 1 is liquidation), or null when no
 * positive price reaches it. Solves E0 + q·(P − P0) = h·(mmRate·|q|·P + mmOther) for P.
 */
export function triggerPrice(s: GuardSnapshot, h: number): number | null {
  if (!s.position || s.position.size <= 0) return null;
  const { p, mmRate, mmOther, q } = decompose(s);
  const denom = q - h * mmRate * Math.abs(q);
  if (denom === 0) return null;
  const price = (h * mmOther - s.equity + q * p.mark) / denom;
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** Health right after closing `fraction` of the position at the current mark. */
export function healthAfterTrim(s: GuardSnapshot, fraction: number): number {
  if (!s.position) return health(s);
  const mm = s.mmReq - s.position.mm * fraction;
  return mm > 0 ? s.equity / mm : Number.POSITIVE_INFINITY;
}

/** Distance from the mark to the liquidation price, in % of the mark. */
export function distToLiqPct(s: GuardSnapshot): number | null {
  const p = s.position;
  if (!p || p.mark <= 0) return null;
  const liq = p.liqPrice ?? triggerPrice(s, 1);
  if (liq === null) return null;
  return (Math.abs(p.mark - liq) / p.mark) * 100;
}

export interface Triggers {
  warn: number | null;
  trim: number | null;
  flatten: number | null;
  liq: number | null;
}

export function triggers(s: GuardSnapshot, r: { warnHealth: number; trimHealth: number; flattenHealth: number }): Triggers {
  return {
    warn: triggerPrice(s, r.warnHealth),
    trim: triggerPrice(s, r.trimHealth),
    flatten: triggerPrice(s, r.flattenHealth),
    liq: s.position?.liqPrice ?? triggerPrice(s, 1),
  };
}
