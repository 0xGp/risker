# DoraHacks BUIDL submission: RiskGuard
Fill in: `{{DEMO_VIDEO_URL}}` `{{TELEGRAM_BOT_LINK}}` `{{X_POST_1..3_URL}}` and the tx links. Repo: https://github.com/0xGp/risker

**Name:** RiskGuard · **Track:** MVP · **Category:** Trader tools (+ Bots & Agents)
**Tagline:** Keep trading in the app. RiskGuard won't let a wick liquidate you.
**Short (280):** Telegram liquidation guard for dreamDEX BTC-PERP on Somnia. It adopts the positions you open in the app, watches them via Somnia Reactivity on every price update, and trims or flattens (reduce-only) before liquidation. Optional 15m Breakout/Trend strategy under the same guard.

## Features mapped to judging criteria
| Criterion | What RiskGuard does | Proof |
|---|---|---|
| **MVP potential: user value** | Stops manual leveraged traders from being liquidated while away from the screen, from Telegram, no code | {{DEMO_VIDEO_URL}} · [How it works](https://github.com/0xGp/risker#how-it-works) |
| **MVP potential: credible scope** | 1 market, reduce-only guard with 3 button profiles, 2 transparent presets, built on the official bot kit | [Honest status](https://github.com/0xGp/risker#honest-status) |
| **MVP potential: viral / repeat loop** | "Saved from liquidation" card with one-tap X share, daily recap, `?start=<ref>` onboarding{{MULTI_TENANT_NOTE}} | {{SCREENSHOT_CARD}} |
| **MVP potential: execution** | Deployed 24/7, {{TEST_COUNT}} tests, pure guard + strategy engines, deterministic action log, guard > strategy arbiter | [Tests](https://github.com/0xGp/risker#tests) · [Stack](https://github.com/0xGp/risker#somnia--dreamdex-stack-used) |
| **Somnia primitives (plus)** | Off-chain Reactivity (`accountPositions.subscribe`, `somnia_watch`) on every price write; Link a Bot | `/status` → `source: reactivity` |
| **Evidence: live orders** | Real reduce-only guard orders on manual positions + strategy IOC orders on BTC-PERP (Hideki testnet 50383) | [{{TX_GUARD_SHORT}}]({{EXPLORER_TX_GUARD}}) |
| **Evidence: tx hashes** | {{TX_COUNT}} hashes incl. {{GUARD_TX_COUNT}} guard actions and {{STRATEGY_TX_COUNT}} strategy orders | [EVIDENCE.md](https://github.com/0xGp/risker/blob/main/EVIDENCE.md) |
| **Evidence: repo** | Public, MIT, README with run steps | https://github.com/0xGp/risker |
| **Evidence: demo** | 3-min video | {{DEMO_VIDEO_URL}} |
| **Communication: X posts** | 3 accurate posts tagging @DreamDEXSomnia, every number backed by a tx | {{X_POST_1_URL}} · {{X_POST_2_URL}} · {{X_POST_3_URL}} |

## Submission checklist
- [ ] DoraHacks email whitelisted (Discord ticket or SomniaHacks Telegram), **do this first**
- [ ] Repo public and opens logged out · [ ] Video public · [ ] Every link clicked from an incognito window
- [ ] README has the **X posts** section with 2–3 links tagging @DreamDEXSomnia
- [ ] `feedback/` files use the official format (Severity: critical | major | normal; Area: API | SDK | docs | app | contracts)
- [ ] Bounty-account funds only; nothing moved into Arena · [ ] Submitted by **Nov 1 20:00 WAT** (hard deadline Nov 2 00:59 WAT)
