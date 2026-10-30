import type { AccountPositionsData, AccountPositionsView } from "@somnia-chain/markets-sdk";
import type { Chain } from "./chain.js";
import type { GuardSnapshot, PositionView } from "./types.js";

export type Source = "reactivity" | "poll";

/** Prices are 18-decimal on every perp market; sizes use baseDecimals, collateral uses quoteDecimals. */
const PRICE_DECIMALS = 18;
const toNum = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

/** BTC-PERP slice of one account view, in human units. Null when health can't be read (e.g. un-priceable). */
export function toGuardSnapshot(data: AccountPositionsData, c: Pick<Chain, "market">): GuardSnapshot | null {
  const info = c.market.info;
  const qd = info.quoteDecimals;
  if (data.margin.health.status !== "known") return null;
  const h = data.margin.health.value;
  const raw = data.positions.find((p) => p.pool.toLowerCase() === info.poolAddress.toLowerCase());
  let position: PositionView | null = null;
  if (raw) {
    if (raw.marks.status !== "known") return null;
    const size = toNum(raw.size < 0n ? -raw.size : raw.size, info.baseDecimals);
    position = {
      side: raw.size > 0n ? "long" : "short",
      size,
      entry: toNum(raw.avgEntryPrice, PRICE_DECIMALS),
      mark: toNum(raw.marks.markPrice, PRICE_DECIMALS),
      liqPrice: raw.liquidationPrice.status === "known" && raw.liquidationPrice.value !== null ? toNum(raw.liquidationPrice.value, PRICE_DECIMALS) : null,
      notional: toNum(raw.marks.notional, qd),
      mm: toNum(raw.marks.maintenanceMarginRequirement, qd),
      unrealizedPnl: toNum(raw.marks.unrealizedPnl, qd),
    };
  }
  return {
    block: Number(data.blockNumber),
    observedAtMs: data.observedAtMs,
    equity: toNum(h.equity, qd),
    mmReq: toNum(h.mmReq, qd),
    position,
  };
}

export interface WatchEvent {
  snapshot: GuardSnapshot | null;
  data: AccountPositionsData;
  source: Source;
  stale: boolean;
}

/**
 * Somnia Reactivity via `accountPositions.subscribe`: the node pushes a one-block account read on
 * MarginBank events and on every price write. If no view arrives for 15 s, read it ourselves every 5 s.
 */
export class Watcher {
  source: Source = "reactivity";
  lastViewAt = 0;
  lastBlock = 0;
  private pushTimes: number[] = [];
  private stop?: () => void;
  private timer?: NodeJS.Timeout;
  private loggedFirst = false;

  constructor(
    private readonly c: Chain,
    private readonly onEvent: (e: WatchEvent) => void,
    private readonly log: (msg: string) => void = console.log,
  ) {}

  start(): void {
    const { marginBank } = this.c.market.info;
    this.stop = this.c.exchange.client.accountPositions.subscribe(marginBank, this.c.owner, (view) => this.onView(view, "reactivity"));
    this.timer = setInterval(() => void this.fallback(), 5_000);
  }

  close(): void {
    this.stop?.();
    if (this.timer) clearInterval(this.timer);
  }

  /** Views received in the last 60 s. */
  get updatesPerMin(): number {
    const now = Date.now();
    this.pushTimes = this.pushTimes.filter((t) => now - t < 60_000);
    return this.pushTimes.length;
  }

  get ageMs(): number {
    return this.lastViewAt ? Date.now() - this.lastViewAt : Number.POSITIVE_INFINITY;
  }

  private onView(view: AccountPositionsView, source: Source): void {
    if (view.status === "failed") return this.log(`account view failed: ${view.error.message ?? view.error}`);
    if (view.status !== "ready" && view.status !== "stale") return;
    if (!this.loggedFirst) {
      this.loggedFirst = true;
      console.dir(view, { depth: 6 });
    }
    const block = Number(view.data.blockNumber);
    if (block < this.lastBlock) return;
    this.lastBlock = block;
    this.lastViewAt = Date.now();
    this.pushTimes.push(this.lastViewAt);
    this.source = source;
    this.onEvent({ snapshot: toGuardSnapshot(view.data, this.c), data: view.data, source, stale: view.status === "stale" });
  }

  private async fallback(): Promise<void> {
    if (this.ageMs < 15_000) return;
    try {
      const snap = await this.c.exchange.client.accountPositions.getSnapshot(this.c.market.info.marginBank, this.c.owner);
      this.onView(snap, "poll");
    } catch (err) {
      this.log(`poll fallback failed: ${(err as Error).message}`);
    }
  }
}
