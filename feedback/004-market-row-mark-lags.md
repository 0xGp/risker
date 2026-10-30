# The indexer market row's markPrice lags the live mark by almost 1%

Severity: normal
Area: API

## Steps to reproduce
1. `requireMarket(exchange, "BTC-PERP")` and read `market.info.markPrice`.
2. In the same second read the live mark (`liveMark` in perp-core, i.e. the pool's health snapshot).

## Expected
The two agree to within a few bps, or the row says how old its price is.

## Actual
On 2026-10-30 around 20:05 WAT:
```
live mark 76378.05967578506 (market row says 77008.22941205895)
```
That's a 0.82% gap. At 20x leverage that's 16% of a trader's margin, so a bot sizing or triggering off the row would be badly wrong.

## Evidence
`npm run doctor` output (RiskGuard repo). RiskGuard never uses the row mark: guard decisions use the account view's per-block `marks.markPrice`, and order sizing uses `liveMark`.

## Environment
markets-sdk 0.32.1 · Somnia Hideki testnet (50383) · indexer https://hideki-dev.smk.somnia.host/v1/graphql

## Suggestion
Add an `updatedAtBlock` / `observedAt` to the market row's price fields, or drop `markPrice` from the row and point to `getPerpHealthSnapshot`.
