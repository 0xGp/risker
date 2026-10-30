# RiskGuard (risker)

RiskGuard is a Telegram liquidation guard for dreamDEX perps on Somnia. You keep trading by hand in the app. RiskGuard watches your account every block through Somnia Reactivity. As health falls it **warns, then trims, then flattens**, always reducing and never opening. An optional deterministic strategy (1h breakout or EMA 9/21 trend) runs under the same guard.

- **How it's built and why:** [ARCHITECTURE.md](ARCHITECTURE.md) (decisions, verified results)
- **Product spec:** [DESIGN.md](DESIGN.md)
- **SDK feedback:** [feedback/](feedback/)
- **Submission material:** [submission-kit/](submission-kit/)

## Status
- Code complete: guard, strategy, Telegram UX, SQLite state, evidence log.
- 59 unit tests pass, and the typecheck is clean.
- Live read-only checks pass on Hideki (50383). The guard's liquidation-price solve matches the chain's own figure on real long and short positions.
- Still to do on chain: link a bot to a real account and collect tx-hash evidence (ARCHITECTURE.md §4).

## Quick start
```bash
npm i
cp .env.example .env          # OWNER_ADDRESS, TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_IDS
npm run keygen                # bot key goes in .env only; link its address in the app and send it some STT
npm run doctor                # preflight
npm run dev                   # DRY_RUN=true by default
```

Telegram commands: `/guard` `/status` `/close [pct]` `/panic` `/snooze` `/strategy` `/pause` `/resume` `/rules` `/history` `/stats`.

Safety: the bot key can trade for your account but cannot withdraw. Never paste a private key in Telegram (the bot deletes any message that looks like one). `DRY_RUN=true` and `MAX_ORDER_USD=100` are the defaults.

Credits: `src/vendor/perp-core` is copied from the dreamDEX bot kit (MIT, see its NOTICE.md).
