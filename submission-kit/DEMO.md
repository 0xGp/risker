# RiskGuard: 3-minute demo runbook

## Before recording
1. `npm test` green; `npm run doctor` shows the BTC row, mark, 3 closed 15m candles, link OK, bot STT > 0.1.
2. `DRY_RUN=false`, the bot running on the server; `/status` shows `source: reactivity` and a fresh update age.
3. **Use a real save, not tight thresholds.** Open a 15–20x manual position in the app with the Balanced profile and record the screen until the guard acts (at 20x the trim level is ~1.25% away). Keep the best real clip as `{{GUARD_CLIP}}`; the numbers you say must match its tx.
4. Explorer tab open on the bot wallet `{{BOT_WALLET_ADDRESS}}`. Telegram on desktop, large font, notifications off.

| Time | Shot | On screen | Point to land |
|---|---|---|---|
| 0:00–0:15 | Hook | A liquidation screenshot → RiskGuard | "A 2.5% wick liquidates 20x while you're at work" |
| 0:15–0:40 | Link | App → Link a bot → `/start` link check | Bot key can reduce, never withdraw |
| 0:40–1:10 | Guard setup | `/guard` → Balanced → Protect → confirm card with trigger prices | Buttons, exact prices, no LLM |
| 1:10–1:30 | Adopt | Open a 20x long in the app → "Watching your 20x long · trim ≈ … · liq ≈ …" | It guards what *you* trade |
| 1:30–2:15 | Save | `/status` (source: reactivity) → warn → trim message → explorer tx → saved card | Reactivity push on every price write, real tx |
| 2:15–2:40 | Strategy | `/strategy` → Breakout → a candle decision with its reason → tx | Optional, deterministic, under the guard |
| 2:40–3:00 | Close | README "Start here" + EVIDENCE.md + X post | Repo, evidence, @DreamDEXSomnia |

**Things that will bite you:** the price may not move enough during a short recording (record a long session, cut the real event); an IOC with no fill reverts (retry logic in DESIGN §10); low STT stops orders; the indexer can lag a candle.
