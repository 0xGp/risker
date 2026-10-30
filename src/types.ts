export type Side = "long" | "short";
export type Origin = "manual" | "strategy";

/** One BTC-PERP position, in human units (BTC, USDso). */
export interface PositionView {
  side: Side;
  /** Absolute size in BTC. */
  size: number;
  entry: number;
  mark: number;
  /** Liquidation price moving only this market, or null when no BTC price alone liquidates the account. */
  liqPrice: number | null;
  notional: number;
  /** This position's share of the maintenance requirement, USDso. */
  mm: number;
  unrealizedPnl: number;
}

/** The account state the guard evaluates, from one Reactivity push or poll. */
export interface GuardSnapshot {
  block: number;
  observedAtMs: number;
  /** Account equity in the MarginBank, USDso (cross margin, all markets). */
  equity: number;
  /** Account maintenance requirement, USDso (all markets). */
  mmReq: number;
  position: PositionView | null;
}

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
