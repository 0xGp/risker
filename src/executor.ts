import { ORDER_TYPE } from "@somnia-chain/markets-sdk";
import type { Chain } from "./chain.js";
import type { Config } from "./config.js";
import type { Store } from "./db.js";
import { recordTx } from "./evidence.js";
import type { Side } from "./types.js";
import { alignPrice, sizeForNotional, toRaw } from "./vendor/perp-core/markets.js";
import { cancelQuietly, closePosition, placePerp, sizeOrder, type PlaceResult } from "./vendor/perp-core/orders.js";

export type ExecStatus = "filled" | "no-fill" | "dry-run" | "skipped" | "failed";

export interface ExecResult {
  status: ExecStatus;
  hash?: string;
  /** Filled size in BTC. */
  filled: number;
  detail?: string;
}

/** Friendly text for the pool's named errors. */
export function explain(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (m.includes("OnlyApprovedContracts")) return "the bot key is not linked to this account for BTC-PERP (Link a bot → Perps in the app)";
  if (m.includes("InsufficientCollateral") || m.includes("0x3a23d825")) return "not enough free margin in the Perps account";
  if (m.includes("MaxPositionSizeExceeded") || m.includes("0x714b36d6")) return "the order would exceed the market's max position size";
  if (m.includes("IsolatedMarketBlocked")) return "isolated margin blocks this market while another position is open";
  if (m.includes("voucherBlocked")) return "this account trades on competition credit that BTC-PERP doesn't accept";
  if (m.includes("insufficient funds")) return "the bot wallet is out of STT for gas";
  return m.split("\n")[0]!.slice(0, 200);
}

export class Executor {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly c: Chain,
    private readonly cfg: Config,
    private readonly store: Store,
  ) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private bd() {
    return this.c.market.info.baseDecimals;
  }

  private result(res: PlaceResult): ExecResult {
    const filled = Number(res.filled) / 10 ** this.bd();
    if (!res.sent) return { status: this.cfg.dryRun ? "dry-run" : "skipped", filled: 0 };
    if (res.noFill) return { status: "no-fill", hash: res.hash, filled: 0 };
    return { status: "filled", hash: res.hash, filled };
  }

  private log(kind: string, side: Side | null, r: ExecResult, price: number | null, reason: string, extra?: Record<string, unknown>) {
    if (r.status === "skipped") return;
    recordTx(this.store, this.cfg.evidenceDir, {
      kind,
      side,
      qty: r.filled || null,
      price,
      tx_hash: r.hash ?? null,
      status: r.status === "filled" ? "filled" : r.status === "no-fill" ? "no-fill" : r.status === "dry-run" ? "dry-run" : "failed",
      error: r.status === "failed" ? (r.detail ?? null) : null,
      reason,
      ts: Date.now(),
      extra,
    });
  }

  /**
   * Close `fraction` of the BTC position with an opposite-side IOC sized from the pool's close preview,
   * read immediately before sending. Widens slippage on each IOC no-fill.
   */
  reduce(o: { fraction: number; kind: string; reason: string; side: Side; mark: number; slippages?: number[]; extra?: Record<string, unknown> }): Promise<ExecResult> {
    return this.serial(async () => {
      const slippages = o.slippages ?? [this.cfg.slippageBps, this.cfg.slippageBps * 2];
      let last: ExecResult = { status: "skipped", filled: 0 };
      for (const slippageBps of slippages) {
        try {
          last = this.result(await closePosition(this.c.write, this.c.market, this.c.owner, { fraction: o.fraction, label: o.kind, slippageBps }));
        } catch (err) {
          last = { status: "failed", filled: 0, detail: explain(err) };
          this.log(o.kind, o.side === "long" ? "short" : "long", last, o.mark, o.reason, o.extra);
          return last;
        }
        this.log(o.kind, o.side === "long" ? "short" : "long", last, o.mark, `${o.reason} (slippage ${slippageBps} bps)`, o.extra);
        if (last.status !== "no-fill") return last;
      }
      return last;
    });
  }

  /** Strategy entry: IOC at mark ± slippage, sized by the pool's own max-size rule. */
  open(o: { side: Side; sizeUsd: number; mark: number; reason: string; extra?: Record<string, unknown> }): Promise<ExecResult> {
    return this.serial(async () => {
      const info = this.c.market.info;
      const price = alignPrice(toRaw(o.mark, 18), info);
      const wanted = sizeForNotional(o.sizeUsd, info, o.mark);
      if (wanted === 0n) {
        const r: ExecResult = { status: "failed", filled: 0, detail: `$${o.sizeUsd} is below the minimum size at ${o.mark}` };
        this.log("strategy-open", o.side, r, o.mark, o.reason, o.extra);
        return r;
      }
      try {
        const sized = await sizeOrder(this.c.exchange, { market: this.c.market, account: this.c.owner, side: o.side, price, wanted, tradingKey: this.c.tradingKey });
        if (!sized.ok) {
          const r: ExecResult = { status: "failed", filled: 0, detail: sized.reason };
          this.log("strategy-open", o.side, r, o.mark, o.reason, o.extra);
          return r;
        }
        const r = this.result(
          await placePerp({ ctx: this.c.write, market: this.c.market, side: o.side, price, quantity: sized.quantity, orderType: ORDER_TYPE.MARKET, slippageBps: this.cfg.slippageBps, label: "strategy open" }),
        );
        this.log("strategy-open", o.side, r, o.mark, o.reason, o.extra);
        return r;
      } catch (err) {
        const r: ExecResult = { status: "failed", filled: 0, detail: explain(err) };
        this.log("strategy-open", o.side, r, o.mark, o.reason, o.extra);
        return r;
      }
    });
  }

  cancelOrders(orderIds: bigint[]): Promise<void> {
    return this.serial(async () => {
      for (const id of orderIds) await cancelQuietly(this.c.write, this.c.market, id);
    });
  }
}
