# dreamDEX SDK & Bot Kit: integration feedback (RiskGuard)

Built against `@somnia-chain/markets-sdk@0.32.1` + [dreamdex-bot-kit](https://github.com/somnia-chain/dreamdex-bot-kit) on Somnia Tokyo testnet (Hideki, 50383), Oct 2026. Every item was hit in practice. One file per issue in [`feedback/`](../feedback/) at the repo root, in the bounty's Feedback-track format. Ordered by time lost.

Security issues never go in the repo: send them privately to security@dreamdex.io.

| # | Title | Severity | Area | File |
|---|---|---|---|---|
| 1 | {{TITLE}} | {{critical/major/normal}} | {{API/SDK/docs/app/contracts}} | [feedback/001-….md](../feedback/001-example.md) |

## Template (copy to `feedback/NNN-short-slug.md`)
```markdown
# Short title

Severity: critical | major | normal
Area: API | SDK | docs | app | contracts

## Steps to reproduce
1. ...

## Expected

## Actual

## Evidence
Transaction hash, request and response, screenshots

## Environment
SDK version, network (Somnia Tokyo testnet), wallet address
```

Payout: $40 per accepted critical/major item, $15 for others; only reproducible, first-reported items count.

## Likely candidates to check while building
- `accountPositions` view: field names for liq price / health aren't documented.
- `fetchOHLCV("15m")`: whether the newest bucket is the still-open candle.
- `perp-core` is a private workspace package (`"private": true`), so it must be vendored.
- Reading the account's current perp leverage in linked mode.
- Explorer tx URL format for the Tokyo testnet.

## What was good
{{WHAT_WORKED_WELL}}
