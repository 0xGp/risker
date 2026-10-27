# EXAMPLE (replace or delete): perp-core is a private workspace package, so external projects must copy it

Severity: normal
Area: SDK

## Steps to reproduce
1. In a fresh project run `npm i @dreamdex-bot-kit/perp-core`.

## Expected
Installs the perp helpers (`placePerp`, `closePosition`, `healthRatio`…).

## Actual
{{ACTUAL_OUTPUT: confirm before submitting; the kit's package.json says "private": true}}

## Evidence
{{ERROR_TEXT_OR_SCREENSHOT}}

## Environment
markets-sdk 0.32.1 · Node {{NODE_VERSION}} · Somnia Tokyo testnet (Hideki, 50383) · wallet {{WALLET_ADDRESS}} · {{DATE_WAT}}

## Suggestion
Publish perp-core to npm, or document vendoring.
