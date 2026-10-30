# RiskGuard — DESIGN.md (v3, guard-first)

> A Telegram liquidation guard for your dreamDEX BTC-PERP position. Trade in the app as usual; RiskGuard watches your account through Somnia Reactivity on every price update, warns you, trims and, as a last resort, flattens before you get liquidated. An optional 15-minute auto-strategy runs under the same guard.

Hackathon: dreamDEX Perps Builder Bounty (Somnia, DoraHacks, MVP track). **Deadline Nov 1 23:59 UTC = Nov 2 00:59 WAT. Internal submit target: Nov 1 20:00 WAT.**
Status legend: ✅ verified (docs, kit code or a live call on Oct 25 2026) · ⚠️ unverified, check on Day 1.
Categories: **trader tools** (primary) + **bots/agents**. Interface: **Telegram only**.

### What changed from v2
- **The guard is the product.** It adopts positions the user opens **manually in the app** (any leverage up to 20x), not only the bot's own trades. In v2 the guard could never fire organically: strategy trades were capped at 5x with SL ≤ 1.5%, so the SL always hit ~16 points before liquidation.
- **Guard profiles + modes** (`alert` / `protect`), set with buttons, with trigger prices shown up front.
- **The strategy is secondary:** 2 presets (Breakout, Trend). Mean-revert is cut (a ≥1% single 15m candle is too rare to produce evidence).
- **Manual `/long` `/short` are cut** (users trade in the app). `/close`, `/panic` stay.
- **Multi-tenant guard** if one bot EOA can be linked by many owners (Day 1 spike), with an on-chain ownership proof for `/link`. Otherwise single tenant.
- The day plan restarts from Tue Oct 27 (nothing was scaffolded yet).

---

## 0. Verified facts

| Topic | Fact |
|---|---|
| Network | Hideki testnet, chain `50383` (the app's "DreamDEX" region; explorer `explorer.testnet.somnia.network/tokyo` = the bounty's "Tokyo testnet"). RPC `https://api.hideki2.infra.testnet.somnia.network`, WS `wss://api.hideki2.infra.testnet.somnia.network/ws`, indexer `https://hideki-dev.smk.somnia.host/v1/graphql`. Gas = STT. ✅ |
| SDK | `@somnia-chain/markets-sdk@0.32.1` (the version the app runs) ✅. `new SomniaMarkets({ chain: hidekiTestnet, indexerUrl, addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES, privateKey })` ✅ (ran it live). |
| Market | **BTC-PERP**: 20x max, IM 5% / MM 2.5%, tick 0.1, min size 0.00013 BTC, Paper USDso allowed ✅. Unified symbol `BTC/USDso:USDso` ✅ (live `loadMarkets()`). Base decimals 8, price 18 ✅. Pool read from the market row (`poolAddress`, currently `0x4181dd08…94c0`); never hardcode it. |
| Not in scope | The 15m BTC **Up/Down event contracts** (binary, `intervalSec: 900`). Perp only. |
| 15m candles ✅ | `markets.fetchOHLCV("BTC/USDso:USDso", "15m", since?, limit?)` → `[[tsMs, o, h, l, c, vol], …]`, human units, ascending. Fallback `markets.client.getCandles(btc.poolAddress, 900, { limit })` (raw 1e18 strings). ⚠️ The newest bucket may still be open, so a candle counts as closed only when `tsMs + 900_000 <= now`. 1h = `"1h"` / `3600`. |
| Reactivity ✅ | Off-chain Reactivity (`eth_subscribe("somnia_watch")`) pushes live on the Hideki WS (tested). `client.accountPositions.subscribe(marginBank, account, onView)`: the node pushes a one-block account read on account-naming MarginBank events **and price-feed writes**; the SDK falls back to reading every 5 s. On-chain Reactivity handlers are **not** used. |
| Link a Bot ✅ | The bot's EOA is linked to the user's app wallet and can **place / cancel / reduce orders only**. It cannot withdraw, set leverage, arm exchange TP/SL or move margin. Kit linked mode = `OWNER_ADDRESS` set. |
| ⚠️ Reduce a manual position | That a linked bot's reduce-only order reduces a position **the user opened in the app** (same margin account, so expected). **Critical Day 1 spike:** open a min-size manual long, then `/close 50` from the bot. |
| ⚠️ One bot, many owners | Whether several owner wallets can link the **same** bot EOA. Yes → multi-tenant guard (§4). No → single tenant. |
| Consequences | The guard can only **reduce** risk (trim/flatten/close). It can't add margin or lower leverage; it deep-links the user to the app for that. For strategy trades, leverage is the account setting, so the bot refuses to open if account leverage > the preset cap. Strategy TP/SL are bot-side. |
| Prior art | The kit's `perp-guard` / `perp-starter` + `packages/perp-core` (`marginSnapshot`, `healthRatio`, `positionIn`, `sizeOrder`, `placePerp`, `closePosition`, `linkCoverage`) ✅. Copied in (MIT), credited in the README. |

---

## 1. Problem
A retail perp trader opens a 15–20x BTC long from their phone, then goes back to work. At 20x, liquidation is ~2.5% away; a single 15-minute wick can do that. They lose most of their margin plus a liquidation fee of up to 1% of the notional. Existing tools are alerts you have to act on yourself, code-only bots, or LLM "agents" that are unpredictable with money.

**Example (illustrative numbers):** Tunde, Lagos. $200 margin, 15x long at 80,500 ($3,000 notional, MM $75, health 2.67, liq ≈ 77,060). BTC wicks −3% in 15 minutes. RiskGuard warns at health < 2.0, trims 25% at < 1.5 (health ×1.33, liq moves ~$1,000 further away), and the wick misses. Cost: ~$22 realized on the trimmed quarter instead of ~$200 + fee.

## 2. Users
Telegram-native retail perp traders (e.g. the Nigerian crypto community) and Perps Arena paper traders on dreamDEX who trade manually with leverage and can't watch the chart all day. Secondary: non-coders who want a simple systematic strategy that can't blow up their account.

## 3. Core loop
1. `/start` → link the bot's address in the app (Link a bot → Perps) → `/link 0xOwner` → link check (+ ownership proof in multi-tenant mode).
2. `/guard` → pick a profile (Conservative · Balanced · Aggressive) and mode (Alert only · Protect) → **confirm card with trigger prices** → guard armed.
3. The user trades in the app as usual. On the first Reactivity push showing a BTC-PERP position, the bot **adopts** it: "Watching your 15x long. Warn ≈ 79,150 · Trim ≈ 78,150 · Flatten ≈ 77,450 · Liq ≈ 77,060."
4. Every push → guard engine → warn / trim / flatten / block, with a tx link and the reason.
5. Optional: `/strategy` → Breakout or Trend → wizard → confirm card → armed. Every closed 15m candle → decision → (if the guard allows) an order.
6. **Repeat/viral loop:** a "Saved from liquidation" card after each guard save (health before → after, liq price moved, tx link), a daily recap at 00:00 WAT, a one-tap X intent tagging @DreamDEXSomnia, and `t.me/<bot>?start=<ref>` on every card. In multi-tenant mode the link onboards the reader straight into their own guard.

## 4. Architecture
```
Telegram (grammY + inline keyboards + @grammyjs/conversations)
   │ /guard wizard, /strategy wizard, /status /close /panic /snooze ...
   ▼
Command layer ──► Config store (SQLite: GuardRules, StrategyParams, owners)
                         │
Reactivity (accountPositions.subscribe, per owner) ──► Adopter (manual vs strategy origin)
                                                          │
                                                          ▼
15m candle clock ── fetchOHLCV("15m"/"1h") ──► ATR%  ──► Guard engine (pure) ── GuardDecision{flatten|trim|tp|sl|warn|block}
                                     └──────────────► Strategy engine (pure) ── Intent{open long/short | close | none}
                                                                         ▼
                                                     Arbiter (guard > strategy) ──► Executor (perp-core placePerp/closePosition,
                                                                                     reduce-only, 10M gas, idempotency) ──► recordTx → SQLite + evidence/txs.jsonl
                                                                                                                     └──► Telegram msg + cards
```
- Node 20 + TypeScript (ESM), `tsx`, `vitest`, `grammy`, `@grammyjs/conversations`, `viem`, `markets-sdk@0.32.1`, `better-sqlite3`, `zod`, `@resvg/resvg-js` + `satori` for cards (or plain text if cut).
- Runs 24/7 on Railway/VPS with WebSocket egress (the SDK fails with "genesis check failed" without it ✅).
- **Tenancy.** One bot key per deployment. Single-tenant mode: one owner, allowlisted chat IDs. Multi-tenant mode (only if the ⚠️ spike passes): one owner per chat, one Reactivity subscription per owner, capped at `MAX_OWNERS` (default 25), the guard open to anyone with a verified link, **auto-strategy only for allowlisted chats**. The bot key pays all gas; alert on low STT.

### Key management and ownership proof
`BOT_PRIVATE_KEY` = a fresh EOA, env-only. The bot never accepts keys in chat and auto-deletes any 64-hex message. Linked mode means it **cannot withdraw**.
In multi-tenant mode, `/link 0xOwner` alone is not enough (a stranger could claim someone else's linked wallet and trim them). Proof: the bot asks for a transfer of an exact nonce amount of STT (e.g. `0.000137 STT`) from the owner wallet to the bot address, the user pastes the tx hash, and the bot checks `from == owner`, `to == bot`, `value == nonce`, confirmed, < 30 min old. Works from any mobile wallet, no signing page needed. Single-tenant mode trusts the allowlist.

## 5. How rules get set
The user **never types free-form rules in the MVP**. Every rule is a field in a typed, zod-validated object, changed only with buttons (or `/rules set <field> <value>` through the same validator). No LLM.

### 5a. GuardRules (primary)
```ts
type GuardProfile = "conservative" | "balanced" | "aggressive";
interface GuardRules {
  enabled: boolean;
  mode: "alert" | "protect";      // alert = messages only; protect = auto trim/flatten
  profile: GuardProfile;
  warnHealth: number;             // from the profile, editable under "Advanced"
  trimHealth: number;
  flattenHealth: number;
  trimPct: 25 | 50;
  atrTrimMult: number;            // trim if distLiq < atrTrimMult × ATR%(15m)
  atrFlattenMult: number;         // flatten if distLiq < atrFlattenMult × ATR%(15m)
}
```
| Profile | Warn | Trim | Flatten | Trim % | ATR × (trim / flatten) |
|---|---|---|---|---|---|
| Conservative | 2.5 | 1.8 | 1.3 | 50 | 3 / 1.5 |
| **Balanced** (default) | 2.0 | 1.5 | 1.15 | 25 | 2 / 1 |
| Aggressive | 1.6 | 1.3 | 1.1 | 25 | 1.5 / 0.75 |

Validation: `1.05 ≤ flatten < trim < warn`, `trim − flatten ≥ 0.2`, `warn − trim ≥ 0.2`. `health = equity / mmReq` (kit `healthRatio` ✅, 1.0 = liquidation). A trim of `p` at the same mark gives `health_after ≈ health / (1 − p)` (25% → ×1.33, 50% → ×2).
The **confirm card** shows the trigger prices for the current position: solve `health(P) = h` with `equity(P) = E0 + q·(P − P0)` and `mmReq(P) = MM·|q|·P + mmOther` (q signed, MM 2.5%, funding/fees ignored, labelled "≈"). Pure function `triggerPrice(snapshot, h)`; `h = 1` gives the liq price.

### 5b. StrategyParams (secondary)
```ts
type Preset = "breakout" | "trend";
interface StrategyParams {
  preset: Preset;
  sizeUsd: 10|25|50|100;             // notional per trade (custom 5..MAX_ORDER_USD)
  leverage: 2|3|5;                    // CAP; refuse to open if account leverage > this
  tpPct: 0.5|1|1.5|2|3;               // % price move from entry
  slPct: 0.3|0.5|0.75|1|1.5;
  maxTradesPerDay: 1|3|5|10;
  dailyLossLimitUsd: 5|10|25|50;      // realized + unrealized, resets 00:00 WAT
  direction: "both"|"long"|"short";
  breakout?: { lookbackH: 1; bufferPct: 0.05 };
  trend?:    { fast: 9; slow: 21 };   // EMA on 15m closes
}
```
Validation: `slPct < 100/leverage × 0.5`, `sizeUsd ≤ MAX_ORDER_USD`, `sizeUsd/leverage ≤ free margin` (`getMaxPerpOrderSize` ✅), `sizeUsd ≥ minQty × mark`. The confirm card shows margin used, approx. liq distance (~(1/lev − 2.5%)), worst-case loss per trade (`sizeUsd × slPct`) and the daily cap. Changes apply from the **next** candle. Each confirmed config (guard or strategy) gets a version number; every action logs `version` + `paramsHash`.

## 6. Guard engine (the product)
`evaluateGuard(snapshot, rules, atrPct, state) → GuardDecision`, pure. Inputs per Reactivity push: equity, mmReq, BTC position (size, side, entry), mark, liq price if the view has it (⚠️ field names unverified; log the first view), the latest 15m ATR(14)%, and the position's origin.

| Priority | Condition | Action | Applies to |
|---|---|---|---|
| 1 | `/panic` | Close all + cancel resting orders (confirm button) | any position |
| 2 | health < flatten, or distLiq < atrFlattenMult × ATR% | **FLATTEN** (reduce-only, full size) | any position (`protect`) |
| 3 | health < trim, or distLiq < atrTrimMult × ATR% | **TRIM** `trimPct` (reduce-only) | any position (`protect`, unless snoozed) |
| 4 | mark crosses the stored SL / TP | Reduce-only close (bot-side TP/SL) | strategy positions only |
| 5 | health < warn | WARN + block new strategy entries | any position |
| 6 | daily loss ≥ limit, or trades ≥ max/day | Block strategy entries until 00:00 WAT + alert | strategy |
| 7 | data stale > 30 s / bot STT < 0.05 / link missing | Block strategy entries + alert ("guard blind") | all |

- In `alert` mode, levels 2–3 send the message with **[Trim 25%] [Close all] [Ignore]** buttons instead of acting.
- **Adoption.** First view with a BTC position and no open `positions_meta` row → origin `manual`, send the adoption message with trigger prices. Size change (the user adds/reduces in the app) → update the row and resend trigger prices. Positions the strategy opens get origin `strategy`.
- **Never fight the user.** The guard only reduces; it never re-opens. The strategy never closes or adds to a manual position (its exit signals only touch `strategy` positions) and never opens while any position exists. `[Snooze trims 15m]` suppresses level 3 once per position per hour; **flatten is never snoozed** (only `/guard off`, with confirm).
- **Cross margin.** Health is account-wide; the guard only reduces BTC-PERP. If health is low from other markets with no BTC position, it alerts only (documented).
- Hysteresis +0.1 health to re-arm a level, 20 s cooldown per action, idempotency key `(owner, level, blockNumber)`, max 6 auto-actions/hour per owner → alert-only after that. Re-read the position right before sending. Entering already inside the warn zone (e.g. 20x opens at health ≈ 2.0) sends one "opened in warning zone" message, not a stream.
- Trim below `minQuantity` → flatten if health < flatten, else alert.
- Polling fallback if Reactivity misbehaves: `marginSnapshot`/`positionIn` every 5 s; `/status` prints `source: reactivity|poll` and the last update age.

## 7. Strategy engine (optional, deterministic, pure)
`decide(closedCandles15m, candles1h, position, params, dayState) → { intent, reason }`. No I/O, clock or randomness (time comes from the candle), so **the same input always gives the same decision**. Evaluated once per **closed** 15m candle (timer at :00/:15/:30/:45 + 20 s settle; re-fetch if the last closed bucket is missing; skip and log after 60 s). Needs ≥ 30 closed 15m candles.

| Preset | Entry long | Entry short | Exit (besides TP/SL) |
|---|---|---|---|
| **Breakout** | close > prior completed 1h high × (1+buffer) | close < prior 1h low × (1−buffer) | opposite signal → close (no flip) |
| **Trend follow** | EMA9 crosses above EMA21 on 15m closes | EMA9 crosses below EMA21 | opposite cross → close |

One position at a time; skip if any position is open (manual or strategy) except exits of its own position; respect `direction`, `maxTradesPerDay`, the daily loss limit and every guard block. Orders are IOC at mark ± `SLIPPAGE_BPS` (default 30), sized with `sizeOrder`/`alignQuantity`. TP/SL levels stored at fill and watched by the guard. Not financial advice.

## 8. Telegram UX
| Command | Behaviour |
|---|---|
| `/start` | Onboarding: bot address, link steps, link check, disclaimer. `?start=<ref>` records the referrer |
| `/link 0xOwner` | Set and verify the owner (`linkCoverage` ✅); in multi-tenant mode, the STT nonce proof |
| `/guard` | Profile → mode → (Advanced) → **confirm card with trigger prices** [✅ Arm] [✏️ Edit]. `/guard off` needs confirm |
| `/status` | Position (origin, side, size, entry), health, liq price, trigger prices, guard profile/mode, blocks, strategy state + last decision, data source + age |
| `/close [pct]` · `/panic` | Reduce-only close of any position (confirm); panic = close all + cancel |
| `/snooze` | Snooze trims for 15 min on the current position (flatten stays active) |
| `/strategy` · `/pause` · `/resume` | Strategy wizard (Breakout · Trend) → confirm card → Arm; pause/resume the strategy only (the guard stays on) |
| `/rules` | Current GuardRules + StrategyParams; `/rules set trimHealth 1.6` (validated, then confirm) |
| `/history` · `/stats` | Last 10 actions with explorer links; saves, liq distance gained, trades, PnL, + card |

Every action message includes its **reason** and numbers: "TRIM 25%: health 1.49 → 1.98, liq 77,060 → 76,030, reason: health < 1.5".

## 9. Data model (SQLite)
```
owners(chat_id PK, owner_address, verified, referrer, created_at)
guard_rules(id PK, chat_id, version, rules_json, rules_hash, enabled, mode, created_at)
strategy_configs(id PK, chat_id, version, params_json, params_hash, armed, paused, created_at)
day_state(chat_id, day_wat, trades, realized_pnl, blocked_reason)
decisions(id, chat_id, candle_ts, preset, params_version, inputs_hash, intent, reason, executed, blocked_by)
positions_meta(id, chat_id, origin, entry_px, side, qty, tp_px, sl_px, opened_tx, opened_at, closed_tx, pnl, snoozed_until)
guard_actions(id, chat_id, level, mode, health_before, health_after, liq_before, liq_after, qty, tx_hash, block, ts)
snapshots(id, chat_id, block, mark, liq_price, equity, mm_req, health, ts)   -- 1/min + on action
txs(id, chat_id, kind, side, qty, price, tx_hash, status, error, ts)         -- mirrors evidence/txs.jsonl
```

## 10. Edge cases
- Candle not final / indexer lag → close-time rule + re-fetch; never act twice on one `candle_ts` (unique index).
- Restart → position from the chain, rules/TP/SL/day_state from the DB; adopt any position found; a missed candle is not back-traded.
- The user trades in the app during a guard action → re-read before send, reduce-only so it can't flip, idempotency per block.
- IOC no fill (`ImmediateOrCancelNoFill` `0xd48c4403`) → retry once with 2× slippage; for **flatten**, keep retrying every block with widening slippage (cap 2%) until health recovers or the position is gone, alerting each step.
- `voucherBlocked`, `MaxPositionSizeExceeded` (`0x714b36d6`), `IsolatedMarketBlocked`, `InsufficientCollateral` (`0x3a23d825`) → friendly messages.
- Un-priceable mark → `closePosition` refuses (kit note) → alert; block strategy entries.
- Account leverage above the strategy cap → refuse the strategy entry + tell the user to lower it in the app. (Manual positions at any leverage are guarded.)
- Link revoked in the app → `linkCoverage` fails → "guard blind" alert, every 10 min until fixed.
- Gas: 10M limit (kit default ✅); alert on low STT.

## 11. Security
Linked key can't withdraw ✅; env-only secrets; `.gitignore` + gitleaks; chat allowlist (single tenant) or on-chain ownership proof (multi-tenant); confirm on arm / panic / guard-off / close; hard caps (`MAX_ORDER_USD`, strategy leverage ≤ 5, max actions/hr, daily loss, `MAX_OWNERS`); `DRY_RUN=true` default; refuse if chain ≠ 50383; redact errors. **No LLM in the trading path.** Bounty-account funds only, never moved into an Arena account.

## 12. Stretch goals (only after the core is green)
1. **Natural-language rules.** `/rules text "protect my long, trim half if health under 1.8"` → LLM with a JSON-schema tool that can **only** output a partial `GuardRules`/`StrategyParams` → zod → the same confirm card with a diff. Nothing applies without ✅; the LLM never acts.
2. **Public stats page** (read-only, regenerated from SQLite): saves, liq distance gained, tx links.
3. `/backtest <preset>` and a **guard replay**: "on the last 7 days of 15m candles, this profile would have saved a 20x long N times."

## 13. Day-by-day plan (WAT, restarts today)
| Day | Date | Deliverable (done = demoable) |
|---|---|---|
| 1 | Tue Oct 27 | Scaffold via CURSOR_PROMPT; copy in perp-core; bot key created, linked, funded (bounty account); `npm run doctor`. **Spikes:** print the `accountPositions` view; open a min-size manual long in the app → `/close 50` from the bot → **first tx hash**; try linking the same bot from a 2nd wallet. |
| 2 | Wed Oct 28 | Watcher + adopter + pure guard engine + `triggerPrice` + tests; `/guard` wizard + confirm card; `/status /close /panic /snooze`. Live: open a 20x manual long → adoption message → **real warn/trim tx**. Deploy 24/7. |
| 3 | Thu Oct 29 | Candle clock + ATR feeding the guard; strategy engine (Breakout + Trend, pure) + tests; params validator; `/strategy` wizard + confirm card; first live strategy trades. |
| 4 | Fri Oct 30 | "Saved from liquidation" card + daily recap + X intent; `/history /stats`; multi-tenant + ownership proof (if the spike passed); hardening. Freeze features at 22:00. |
| 5 | Sat Oct 31 | README, EVIDENCE.md, 2–3 min demo video, publish the X posts. Stretch only if everything is green. |
| 6 | Sun Nov 1 | Buffer/fixes until 18:00, **submit on DoraHacks by 20:00 WAT**. |

**Cut list (in order):** NL rules → stats page → backtest/replay → multi-tenant → PNG cards (text + X intent) → Trend preset → `/snooze` → ATR-based thresholds (health only) → the whole strategy. **Never cut:** adopting manual positions, a real guard trim/flatten tx, evidence logging, the README, the X posts.

## 14. Evidence collection
`recordTx()` on every send → SQLite + `evidence/txs.jsonl` + Telegram link `https://explorer.testnet.somnia.network/tokyo/tx/<hash>` ⚠️ (confirm the URL format). `npm run evidence` → `EVIDENCE.md`: guard actions on manual positions (health and liq price before → after), strategy entries/exits (candle + reason), manual close/panic. Target **≥ 15 tx hashes: ≥ 3 guard actions on manual positions (≥ 1 trim, ≥ 1 flatten), ≥ 4 strategy orders**.
How to get honest guard evidence: open real 15–20x manual longs/shorts in the app with the Balanced profile. At 20x the trim level (health 1.5) is only ~1.25% away, which BTC covers most days. No fake thresholds. Screenshots: guard wizard, confirm card with trigger prices, adoption message, trim message, saved card, explorer tx. Demo video 2–3 min.

## 15. README outline
1. Pitch + demo video/GIF ("trade in the app, RiskGuard keeps you alive")
2. What it does / who it's for (Tunde's example)
3. How it works: Reactivity → adopter → guard engine; trigger prices; arbiter; optional 15m strategy
4. How rules are set: guard profiles + strategy wizard screenshots, schemas, determinism
5. Built on: markets-sdk, dreamdex-bot-kit perp-core (credited), Somnia off-chain Reactivity, Link a Bot
6. Run it: bot key → Link a bot → `.env` → `npm i && npm run doctor && npm run dev`; Railway
7. Commands
8. Safety model (reduce-only, can't withdraw, ownership proof, never fights the user)
9. **Evidence** (tx table → EVIDENCE.md)
10. **X posts** (2–3 links, tagging @DreamDEXSomnia)
11. Limitations (BTC only, can't add margin, needs uptime → also set exchange TP/SL; trimming realizes losses) & roadmap (all markets, NL rules, on-chain Reactivity guard)
12. License / testnet disclaimer

## 16. Draft X posts
1. "Got liquidated on a wick while you were at work? 😤 RiskGuard lives in Telegram and watches your @DreamDEXSomnia BTC-PERP position on every price update via Somnia Reactivity. Health drops → it trims before liquidation. 20x long, health 1.49 → 1.98, saved: [card] [tx]"
2. "You keep trading in the app. The bot can only *reduce* risk: Link a Bot means it can't withdraw, can't add size, never re-opens. Pick Conservative / Balanced / Aggressive with buttons and see the exact prices where it will act. [video] [repo] @DreamDEXSomnia"
3. "No LLM touching the money. Same push + same rules = same action, and every message shows its reason. Optional 15m Breakout/Trend strategy runs under the same guard. Built for the @DreamDEXSomnia Perps Builder Bounty 🧵 [repo]"

## 17. Judging checklist
- [ ] **User value:** keeps manual leveraged traders from being liquidated, from their phone
- [ ] **Credible scope:** 1 market, reduce-only guard, 2 simple presets, reuses the official kit
- [ ] **Viral/repeat loop:** "saved from liquidation" card, daily recap, X intent, `?start=<ref>` onboarding (multi-tenant)
- [ ] **Execution:** 24/7 deploy, tests on guard thresholds + trigger prices + strategy + validators, deterministic decision log
- [ ] **Somnia primitives:** off-chain Reactivity (`accountPositions.subscribe`, `somnia_watch`) on every price write; source + age in /status; Link a Bot
- [ ] **Live testnet orders:** ≥ 15 hashes incl. ≥ 3 guard actions on manual positions and ≥ 4 strategy orders
- [ ] **Repo + README + EVIDENCE.md + demo video**
- [ ] **2–3 X posts tagging @DreamDEXSomnia**, linked in the README
- [ ] Bounty account funds only; nothing moved into Arena; DRY_RUN default; no keys in chat

## 18. Open items / blockers
- ⚠️ **Critical:** the linked bot can reduce a position opened manually in the app (Day 1 spike). If not, fall back to v2 (guard on strategy positions only) and pitch it as a strategy bot.
- ⚠️ One bot EOA linked by many owners (decides multi-tenant).
- ✅ `accountPositions` view fields (`marks.markPrice`, `liquidationPrice.value`, `margin.health.{equity,mmReq}`; prices 1e18, sizes baseDecimals, collateral quoteDecimals). Verified live; our liq solve equals the chain's (ARCHITECTURE.md §3). The newest `fetchOHLCV` bucket is filtered by `closedOnly`. Account leverage is capped as effective leverage instead (ARCHITECTURE.md ADR-8).
- ⚠️ Explorer tx URL format (`EXPLORER_TX_URL`, overridable): check on the first live tx.
- Funding: Paper USDso is claimable once per address with no positions (`getPerpVoucherEligibility` / `claimPerpVoucher` ✅). Confirm which wallet is the bounty account.
- The guard depends on uptime; tell users to also set exchange TP/SL in the app.
