# Vendored: @dreamdex-bot-kit/perp-core

Copied from https://github.com/somnia-chain/dreamdex-bot-kit/tree/4e75896896e024c03e2033d5920514f249998cd6/packages/perp-core/src
(MIT, Copyright DreamDEX S.A., see `LICENSE`). The package is `"private": true` in the kit, so it cannot be installed from npm.

Local changes:
- `orders.ts`: `PlaceResult` carries the transaction `hash`, so every order can be logged as evidence.
- `orders.ts`: `closePosition` accepts `slippageBps`, so a flatten can retry with a wider limit after an IOC no-fill.
