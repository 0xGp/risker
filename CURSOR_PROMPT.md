# First Cursor prompt (Agent mode, repo `risker/` root: DESIGN.md, submission-kit/, feedback/ already present; scaffold the code alongside them and don't overwrite those)

You are scaffolding **RiskGuard**: a Telegram-only **liquidation guard** for a user's dreamDEX BTC-PERP position (including positions they open **manually in the app**), with an optional 15-minute strategy that runs under the same guard. dreamDEX on Somnia Hideki testnet, chain 50383. Read `DESIGN.md` (v3) fully first; it is the source of truth. **Never invent SDK functions.** Use only the names below or ones you find in `node_modules/@somnia-chain/markets-sdk` type definitions; otherwise write `// TODO(verify): …`. **No LLM in the trading path.** The guard only ever **reduces** a position.

## Verified APIs you may use
- `new SomniaMarkets({ chain: hidekiTestnet, indexerUrl: "https://hideki-dev.smk.somnia.host/v1/graphql", addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES, privateKey })` from `@somnia-chain/markets-sdk` + `@somnia-chain/markets-sdk/chains`
- `markets.client.listPerpMarkets()` → BTC row via `baseSymbol === "BTC"` (`poolAddress`, `marginBank`, `baseDecimals`, `quoteDecimals`)
- `await markets.loadMarkets(); markets.fetchOHLCV("BTC/USDso:USDso", "15m" | "1h", since?, limit?)` → `[tsMs,o,h,l,c,v][]`
- `markets.client.accountPositions.subscribe(marginBank, owner, onView)` returns an unsubscribe fn (Reactivity)
- `markets.client.getMaxPerpOrderSize({ pool, marginBank, account, isBid, price })`, `markets.client.getMarginAccount(marginBank, account)`
- From the copied kit perp-core: `marginSnapshot`, `healthRatio`, `positionIn`, `sizeOrder`, `placePerp`, `closePosition`, `linkCoverage`, `liveMark`, `alignPrice`, `alignQuantity`, `createExchange`

## Do
1. Node 20 + TS ESM: `tsx vitest grammy @grammyjs/conversations viem @somnia-chain/markets-sdk@0.32.1 better-sqlite3 dotenv zod`.
2. `git clone --depth 1 https://github.com/somnia-chain/dreamdex-bot-kit /tmp/kit` → copy `/tmp/kit/packages/perp-core/src/*` into `src/vendor/perp-core/` (keep the MIT headers, add NOTICE). Make it compile.
3. Files (build in this order; the guard comes first):
   - `src/config.ts`: zod env: `BOT_PRIVATE_KEY OWNER_ADDRESS TELEGRAM_BOT_TOKEN ALLOWED_CHAT_IDS DRY_RUN=true MAX_ORDER_USD=100 SLIPPAGE_BPS=30 MULTI_TENANT=false MAX_OWNERS=25`. Exit if the chain ≠ 50383.
   - `src/rules.ts`: the `GuardRules` zod schema, the three profiles (Conservative / Balanced / Aggressive) and validation exactly per DESIGN §5a; `rulesHash()`.
   - `src/guard/trigger.ts`: **pure** `triggerPrice(snapshot, h)` per DESIGN §5a (`h = 1` → liq price) and `healthAfterTrim(health, pct)`.
   - `src/guard/engine.ts`: **pure** `evaluateGuard(snapshot, rules, atrPct, state) → GuardDecision` per DESIGN §6: priority order, `alert` vs `protect` mode, origin `manual` vs `strategy` (TP/SL only for strategy), snooze (never for flatten), hysteresis +0.1, 20 s cooldown, idempotency `(owner, level, blockNumber)`, 6 actions/hour cap, "opened in warning zone" once.
   - `src/watcher.ts`: Reactivity subscribe per owner, log the first view in full (`console.dir(view,{depth:6})`); polling fallback every 5 s; expose `source` and last-update age.
   - `src/adopter.ts`: on a view with a BTC position and no open `positions_meta` row → origin `manual` + adoption message with trigger prices; on size change → update + resend.
   - `src/executor.ts`: reduce-only trim/flatten/close and strategy opens via the copied `placePerp`/`closePosition` (linked mode when `OWNER_ADDRESS` is set), re-read the position right before sending, 10M gas, IOC retry rules per DESIGN §10, `recordTx()`.
   - `src/arbiter.ts`: guard first; drop strategy intents while any block is active; the strategy never touches a `manual` position.
   - `src/candles.ts`: clock at :00/:15/:30/:45 + 20 s; keep only candles with `ts + 900_000 <= now`; dedupe by candle ts; ATR(14)% for the guard.
   - `src/strategy/indicators.ts` (EMA, ATR) and `src/strategy/engine.ts`: **pure** `decide(closed15m, candles1h, position, params, dayState) → { intent, reason }` for **breakout / trend only** per DESIGN §7. No Date.now, no I/O.
   - `src/params.ts`: the `StrategyParams` zod schema + cross-field validation per DESIGN §5b; `paramsHash()`.
   - `src/evidence.ts`: SQLite + `evidence/txs.jsonl`; `npm run evidence` → `EVIDENCE.md`.
   - `src/db.ts`: schema per DESIGN §9.
   - `src/telegram/`: grammY bot; `/start /link /guard /status /close /panic /snooze /strategy /pause /resume /rules /history /stats`. `/guard` = profile → mode → confirm card with trigger prices → Arm. `/strategy` = Breakout · Trend → conversations wizard (one button row per param) → confirm card with derived risk → Arm. Alert-mode messages carry [Trim 25%] [Close all] [Ignore] buttons. Chat allowlist (single tenant); in `MULTI_TENANT` mode `/link` requires the STT nonce tx-hash proof (DESIGN §4) and the strategy stays allowlist-only. Auto-delete any message containing a 64-hex key.
   - `src/index.ts`: wire it together, graceful shutdown.
4. Tests (vitest): every guard threshold boundary per profile, mode, origin and snooze; hysteresis/cooldown/idempotency; `triggerPrice` round-trips (health at the computed price ≈ h, long and short); `healthAfterTrim`; the rules and params validators; both presets on hand-made candle fixtures (determinism: run twice, equal output); the arbiter priority and "strategy never touches a manual position".
5. `.env.example`, `.gitignore` (`.env`, `*.db`, `evidence/*.jsonl` optional), README skeleton per DESIGN §15. Scripts: `dev start test typecheck evidence doctor` (doctor prints the BTC row, mark, last 3 closed 15m candles, link coverage, bot STT, owner margin, the owner's current BTC position + health + trigger prices for the Balanced profile).

## Don't
- Don't put or request private keys in Telegram, logs, or code.
- Don't let the guard open, add to or flip a position; reduce-only.
- Don't use `placeTakerOrderWithoutVault` (removed), hardcode pools, or assume 18-decimal quantities (BTC = 8; price = 18).
- Don't build mean-revert, manual `/long` `/short`, or the stretch goals (NL rules, stats page, backtest/replay).

Finish with `npm run typecheck && npm test`, then list the remaining `TODO(verify)` items, starting with "linked bot can reduce a manual position" and "one bot EOA, many owners".
