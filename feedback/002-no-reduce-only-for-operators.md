# No reduce-only flag on perp orders, and operator permissions can't be limited to reducing

Severity: normal
Area: contracts

## Steps to reproduce
1. Link a bot key with the app's "Link a Bot" flow (OperatorPermissionsRegistry).
2. Look for a way to place a perp order that can only shrink a position: `placeOrderFor(owner, …)` and the `ORDER_TYPE` enum (LIMIT 0, FILL_OR_KILL 1, MARKET 2, POST_ONLY 3).
3. Check which permissions a link can grant: place, cancel, reduce. `reduceOrderFor` only shrinks a resting order's quantity.

## Expected
A `reduceOnly` flag on perp orders, or a "reduce-only" operator scope. A risk bot ("close my position before liquidation") could then be linked without the right to open or flip positions.

## Actual
A closing order is just an opposite-side MARKET order. If the position changes between sizing and fill (a manual partial close, a liquidation, a second bot), the same order can open a fresh position the other way. A linked bot with "place" can always open new risk.

## Evidence
RiskGuard enforces reduce-only off-chain. It sizes every close from `previewPerpClosePnl(...).closedQuantity` at the current block, and the arbiter never lets a guard action open or add. That is a client-side promise, though, not a guarantee the protocol can show users.

## Environment
markets-sdk 0.32.1 · bot kit 4e75896 · Somnia Hideki testnet (50383) · 2026-10-30 WAT

## Suggestion
Add `reduceOnly` to perp order params (reject or clip at match time). Also add a `reduce-only` operator permission, so risk tools can be linked with a smaller blast radius.
