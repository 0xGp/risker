import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import { HIDEKI_CHAIN_ID, type Config } from "./config.js";
import { linkStatus, createTradingKey, type TradingKey } from "./vendor/perp-core/operator.js";
import { requireMarket, type PerpMarket } from "./vendor/perp-core/markets.js";
import type { WriteCtx } from "./vendor/perp-core/orders.js";

export interface Chain {
  exchange: SomniaMarkets;
  /** Writes for the owner's account; undefined = read-only (no BOT_PRIVATE_KEY). */
  tradingKey?: TradingKey;
  publicClient: PublicClient;
  market: PerpMarket;
  owner: `0x${string}`;
  write: WriteCtx;
}

/**
 * Reads go through the SDK pointed at the owner's address (read-only for that account); writes go
 * through the linked bot key as `placeOrderFor(owner, …)`. The Hideki address set is used on purpose:
 * its `priceFeedScheduler` is what makes Reactivity push the account on every price write.
 */
export async function connect(cfg: Config): Promise<Chain> {
  const chain = defineChain({ ...hidekiTestnet, rpcUrls: { default: { http: [cfg.rpcUrl], webSocket: [cfg.wsRpcUrl] } } });
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) }) as PublicClient;
  const chainId = await publicClient.getChainId();
  if (chainId !== HIDEKI_CHAIN_ID) throw new Error(`RPC ${cfg.rpcUrl} is chain ${chainId}, not Hideki ${HIDEKI_CHAIN_ID}. Refusing to run.`);

  const exchange = new SomniaMarkets({
    chain,
    indexerUrl: cfg.indexerUrl,
    wsRpcUrl: cfg.wsRpcUrl,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
    account: cfg.owner,
  });
  const tradingKey = cfg.botPrivateKey
    ? createTradingKey({ owner: cfg.owner, privateKey: cfg.botPrivateKey, chain, rpcUrl: cfg.rpcUrl })
    : undefined;
  const market = await requireMarket(exchange, "BTC-PERP", { includeHalted: true });
  return { exchange, tradingKey, publicClient, market, owner: cfg.owner, write: { exchange, config: { dryRun: cfg.dryRun }, tradingKey } };
}

export async function linkOk(c: Chain): Promise<{ ok: boolean; place: boolean; cancel: boolean; reduce: boolean }> {
  if (!c.tradingKey) return { ok: false, place: false, cancel: false, reduce: false };
  const s = await linkStatus(c.tradingKey, c.market.info.poolAddress);
  return { ok: s.place && s.cancel, ...s };
}

export async function botStt(c: Chain): Promise<number | null> {
  if (!c.tradingKey) return null;
  const wei = await c.publicClient.getBalance({ address: c.tradingKey.operator });
  return Number(wei) / 1e18;
}
