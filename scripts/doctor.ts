import { botStt, connect, linkOk } from "../src/chain.js";
import { loadConfig } from "../src/config.js";
import { fetchClosed } from "../src/candles.js";
import { health, triggers } from "../src/guard/trigger.js";
import { makeRules } from "../src/rules.js";
import { atrPct } from "../src/strategy/indicators.js";
import { liveMark } from "../src/vendor/perp-core/markets.js";
import { toGuardSnapshot } from "../src/watcher.js";

const ok = (b: boolean) => (b ? "✅" : "❌");

async function main() {
  const cfg = loadConfig();
  const c = await connect(cfg);
  const i = c.market.info;
  console.log(`✅ chain ${await c.publicClient.getChainId()} · ${cfg.dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`✅ ${c.market.display}: pool ${i.poolAddress} · marginBank ${i.marginBank} · base ${i.baseDecimals}d · quote ${i.quoteDecimals}d · tick ${Number(i.tickSize) / 1e18} · lot ${Number(i.lotSize) / 10 ** i.baseDecimals} · min ${Number(i.minQuantity) / 10 ** i.baseDecimals} BTC · IM ${i.initialMarginBps / 100}%`);

  const mark = await liveMark(c.exchange, c.market);
  console.log(`${ok(mark !== undefined)} live mark ${mark ?? "un-priceable"} (market row says ${Number(BigInt(i.markPrice ?? 0)) / 1e18})`);

  const candles = await fetchClosed(c.exchange, "15m", 60);
  for (const k of candles.slice(-3)) console.log(`   15m ${new Date(k.ts).toISOString()} o ${k.open} h ${k.high} l ${k.low} c ${k.close}`);
  console.log(`${ok(candles.length >= 30)} ${candles.length} closed 15m candles · ATR(14) ${atrPct(candles)?.toFixed(3) ?? "n/a"}%`);

  if (c.tradingKey) {
    const l = await linkOk(c);
    console.log(`${ok(l.ok)} bot ${c.tradingKey.operator} → owner ${c.owner}: place ${l.place} cancel ${l.cancel} reduce ${l.reduce}`);
    const stt = await botStt(c);
    console.log(`${ok((stt ?? 0) > 0.05)} bot gas ${stt?.toFixed(4)} STT`);
  } else {
    console.log("⚠️  no BOT_PRIVATE_KEY: read-only (npm run keygen to make one)");
  }

  const view = await c.exchange.client.accountPositions.getSnapshot(i.marginBank, c.owner);
  console.log(`✅ account view at block ${view.data.blockNumber}: ${view.data.positions.length} positions · unlocked ${Number(view.data.margin.unlockedCollateralBalance) / 10 ** i.quoteDecimals} USDso · health ${view.data.margin.health.status}`);
  const snap = toGuardSnapshot(view.data, c);
  if (!snap) console.log("⚠️  health unreadable right now");
  else if (!snap.position) console.log(`   no BTC position · equity ${snap.equity.toFixed(2)} USDso`);
  else {
    const p = snap.position;
    const t = triggers(snap, makeRules("balanced"));
    console.log(`   ${p.side} ${p.size} BTC @ ${p.entry} · mark ${p.mark} · notional ${p.notional.toFixed(2)} · equity ${snap.equity.toFixed(2)} · mmReq ${snap.mmReq.toFixed(2)} · health ${health(snap).toFixed(3)}`);
    console.log(`   balanced triggers: warn ${t.warn?.toFixed(1)} · trim ${t.trim?.toFixed(1)} · flatten ${t.flatten?.toFixed(1)} · liq ${t.liq?.toFixed(1)} (chain liq ${p.liqPrice?.toFixed(1) ?? "n/a"})`);
    if (mark) console.log(`${ok(Math.abs(p.mark / mark - 1) < 0.01)} price scale check: view mark ${p.mark} vs live mark ${mark}`);
  }
  await Promise.race([Promise.resolve(c.exchange.close?.()), new Promise((r) => setTimeout(r, 3000))]);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌", err instanceof Error ? err.message : err);
  process.exit(1);
});
