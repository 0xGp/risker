import { App, type Notifier } from "./app.js";
import { connect } from "./chain.js";
import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { Executor } from "./executor.js";
import { createTelegram } from "./telegram/bot.js";

async function withRetry<T>(what: string, fn: () => Promise<T>, attempts = 10): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      const waitMs = Math.min(30_000, 2_000 * i);
      console.log(`${what} failed (${(err as Error).message.split("\n")[0]}); retry ${i}/${attempts - 1} in ${waitMs / 1000} s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new Store(cfg.dbPath);
  let app: App | null = null;

  const tg = cfg.telegramToken ? createTelegram(cfg, () => app) : null;
  const notifier: Notifier = tg?.notifier ?? { send: async (text) => console.log(`[notify] ${text}`) };

  console.log(`RiskGuard starting · owner ${cfg.owner} · ${cfg.dryRun ? "DRY RUN" : "LIVE"}`);
  const chain = await withRetry("connect", () => connect(cfg));
  if (!chain.tradingKey) console.log("No BOT_PRIVATE_KEY: read-only, the guard will alert but cannot act.");
  app = new App(chain, cfg, store, new Executor(chain, cfg, store), notifier);
  await app.start();
  console.log(`watching ${chain.market.display} (${chain.market.info.poolAddress}) for ${cfg.owner}; bot key ${chain.tradingKey?.operator ?? "none"}`);

  if (tg) {
    await tg.bot.api.setMyCommands(tg.commands).catch(() => undefined);
    void tg.bot.start({ drop_pending_updates: true, onStart: (me) => console.log(`telegram @${me.username} online`) });
    await notifier.send(`🛡️ RiskGuard online (${cfg.dryRun ? "DRY RUN" : "LIVE"}). /status`);
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`${signal}: shutting down`);
    app?.stop();
    await tg?.bot.stop().catch(() => undefined);
    await Promise.race([Promise.resolve(chain.exchange.close?.()), new Promise((r) => setTimeout(r, 3_000))]);
    store.db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
