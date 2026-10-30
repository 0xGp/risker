# Bot kit's createExchange passes the Shannon address set while connected to Hideki

Severity: major
Area: SDK

## Steps to reproduce
1. Clone the dreamDEX bot kit (commit 4e75896) and set `NETWORK=hideki` (the default for the bounty).
2. Open `packages/perp-core/src/exchange.ts`: `createExchange` builds `new SomniaMarkets({ ..., addresses: SOMNIA_TESTNET_ADDRESSES })`.
3. Compare the bundled sets in `@somnia-chain/markets-sdk@0.32.1`:
   ```
   node -e 'import("@somnia-chain/markets-sdk").then(m=>{
     console.log("shannon", m.SOMNIA_TESTNET_ADDRESSES.priceFeedScheduler, m.SOMNIA_TESTNET_ADDRESSES.marginBank);
     console.log("hideki ", m.SOMNIA_HIDEKI_TESTNET_ADDRESSES.priceFeedScheduler, m.SOMNIA_HIDEKI_TESTNET_ADDRESSES.marginBank)})'
   ```

## Expected
On chain 50383 the client uses `SOMNIA_HIDEKI_TESTNET_ADDRESSES`. Its `priceFeedScheduler` is what makes `accountPositions.subscribe` push a fresh account read on every price write.

## Actual
```
shannon 0x7ccAE31E45693475be1e4BAa2360D6997eB2D32B 0xdd4A14A2763FDa39b9759D2D4150DB0e0f085C4E
hideki  0x1998C88D54a240b8C671493f27f58eC416b81D7F 0x478769E1177C0773c43A593DCCc4Ad15F15F1394
```
The live BTC-PERP market row on Hideki reports marginBank `0x478769e1…`, which is the Hideki set. The kit hands the client Shannon's scheduler and bank instead. Orders still work, because pool and bank come from the indexer market row. But anything that reads `addresses.*` watches contracts that don't exist on Hideki: Reactivity price-write pushes, and the address-keyed helpers. The subscription quietly degrades to the SDK's 5 s read loop, and no error is raised.

## Evidence
`riskguard` passes `SOMNIA_HIDEKI_TESTNET_ADDRESSES` explicitly (`src/chain.ts`). `npm run doctor` against Hideki then reads BTC-PERP with marginBank `0x478769e1…` and builds the account view at the live block.

## Environment
markets-sdk 0.32.1 · bot kit 4e75896 · Node 24.20 · Somnia Hideki testnet (50383) · 2026-10-30 WAT

## Suggestion
Pick the address set from the network (`hideki` → `SOMNIA_HIDEKI_TESTNET_ADDRESSES`), or have `SomniaMarkets` refuse an address set whose chain id differs from `chain.id`.
