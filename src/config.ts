import "dotenv/config";
import { getAddress, isAddress } from "viem";
import { z } from "zod";

export const HIDEKI_CHAIN_ID = 50383;

const hexKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x followed by 64 hex characters")
  .transform((s) => s as `0x${string}`);
const address = z
  .string()
  .refine(isAddress, "must be an address")
  .transform((s) => getAddress(s));
const bool = z
  .string()
  .optional()
  .transform((s) => (s === undefined || s.trim() === "" ? undefined : s !== "false" && s !== "0"));

const EnvSchema = z.object({
  BOT_PRIVATE_KEY: hexKey.optional(),
  OWNER_ADDRESS: address,
  TELEGRAM_BOT_TOKEN: z.string().min(20).optional(),
  ALLOWED_CHAT_IDS: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean).map(Number)),
  DRY_RUN: bool.transform((b) => b ?? true),
  MAX_ORDER_USD: z.coerce.number().positive().default(100),
  SLIPPAGE_BPS: z.coerce.number().int().min(1).max(500).default(30),
  RPC_URL: z.string().url().default("https://api.hideki2.infra.testnet.somnia.network"),
  WS_RPC_URL: z.string().default("wss://api.hideki2.infra.testnet.somnia.network/ws"),
  INDEXER_URL: z.string().url().default("https://hideki-dev.smk.somnia.host/v1/graphql"),
  // TODO(verify): explorer path for Hideki txs.
  EXPLORER_TX_URL: z.string().default("https://explorer.testnet.somnia.network/tokyo/tx/"),
  DB_PATH: z.string().default("data/riskguard.db"),
  EVIDENCE_DIR: z.string().default("evidence"),
  NOTIFY_EVERY_CANDLE: bool.transform((b) => b ?? false),
  BOT_USERNAME: z.string().default(""),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid .env:\n${lines.join("\n")}\nSee .env.example.`);
  }
  const e = parsed.data;
  return {
    botPrivateKey: e.BOT_PRIVATE_KEY,
    owner: e.OWNER_ADDRESS,
    telegramToken: e.TELEGRAM_BOT_TOKEN,
    allowedChatIds: e.ALLOWED_CHAT_IDS,
    dryRun: e.DRY_RUN,
    maxOrderUsd: e.MAX_ORDER_USD,
    slippageBps: e.SLIPPAGE_BPS,
    rpcUrl: e.RPC_URL,
    wsRpcUrl: e.WS_RPC_URL,
    indexerUrl: e.INDEXER_URL,
    explorerTxUrl: e.EXPLORER_TX_URL,
    dbPath: e.DB_PATH,
    evidenceDir: e.EVIDENCE_DIR,
    notifyEveryCandle: e.NOTIFY_EVERY_CANDLE,
    botUsername: e.BOT_USERNAME,
  };
}

export const txUrl = (cfg: Pick<Config, "explorerTxUrl">, hash: string) => `${cfg.explorerTxUrl}${hash}`;
