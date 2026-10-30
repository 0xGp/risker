# perp-core is a private workspace package, so external projects must vendor it

Severity: normal
Area: SDK

## Steps to reproduce
1. In a fresh project run `npm view @dreamdex-bot-kit/perp-core`.

## Expected
The perp helpers the kit's docs point to (`placePerp`, `closePosition`, `sizeForNotional`, `createTradingKey`…) install from npm.

## Actual
```
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/@dreamdex-bot-kit%2fperp-core - Not found
```
The kit's `packages/perp-core/package.json` is `"private": true`.

## Evidence
RiskGuard copies the package into `src/vendor/perp-core/` with its LICENSE and a NOTICE pointing at kit commit 4e75896. Every kit fix now has to be merged by hand.

## Environment
markets-sdk 0.32.1 · Node 24.20 · 2026-10-30 WAT

## Suggestion
Publish perp-core (even as `0.x`), or fold `placePerp`/`closePosition`/trading-key helpers into markets-sdk.
