import { writeFileSync } from "node:fs";
import { loadConfig, txUrl } from "../src/config.js";
import { Store } from "../src/db.js";

const cfg = loadConfig();
const store = new Store(cfg.dbPath);
const wat = (ms: number) => new Date(ms + 3_600_000).toISOString().slice(0, 16).replace("T", " ");
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const link = (h: string | null) => (h ? `[${short(h)}](${txUrl(cfg, h)})` : "-");
const f = (n: unknown, d = 2) => (typeof n === "number" ? n.toFixed(d) : "-");

const guard = store.db.prepare("SELECT * FROM guard_actions ORDER BY id").all() as Record<string, any>[];
const txs = store.db.prepare("SELECT * FROM txs ORDER BY id").all() as Record<string, any>[];
const decisions = store.db.prepare("SELECT * FROM decisions WHERE intent != 'none' ORDER BY candle_ts").all() as Record<string, any>[];
const onchain = txs.filter((t) => t.tx_hash);

const out: string[] = [
  "# RiskGuard evidence",
  "",
  `Generated ${new Date().toISOString()} by \`npm run evidence\` from the bot's SQLite log. Network: Somnia Hideki testnet (chain 50383), market BTC-PERP. Owner account \`${cfg.owner}\`.`,
  "",
  `**${onchain.length} on-chain transactions** · ${guard.filter((g) => g.tx_hash && (g.level === "trim" || g.level === "flatten")).length} guard actions · ${txs.filter((t) => t.kind === "strategy-open" && t.tx_hash).length} strategy entries.`,
  "",
  "## Guard actions",
  "",
  "| # | Time (WAT) | Action | Origin | Mark | Health before → after | Liq before → after | Reason | Tx |",
  "|---|---|---|---|---|---|---|---|---|",
  ...guard.map((g, i) => `| ${i + 1} | ${wat(g.ts)} | ${g.level} (${g.status}) | ${g.origin ?? "-"} | ${f(g.mark, 1)} | ${f(g.health_before)} → ${f(g.health_after)} | ${f(g.liq_before, 1)} → ${f(g.liq_after, 1)} | ${g.reason} | ${link(g.tx_hash)} |`),
  "",
  "## Strategy decisions with a signal",
  "",
  "| Candle (WAT close) | Preset | Params v / hash | Intent | Reason | Executed | Blocked by | Tx |",
  "|---|---|---|---|---|---|---|---|",
  ...decisions.map((d) => `| ${wat(d.candle_ts + 900_000)} | ${d.preset} | v${d.params_version} / ${d.params_hash} | ${d.intent} | ${d.reason} | ${d.executed ? "yes" : "no"} | ${d.blocked_by ?? "-"} | ${link(d.tx_hash)} |`),
  "",
  "## All orders",
  "",
  "| # | Time (WAT) | Kind | Side | Qty (BTC) | Price | Status | Reason | Tx |",
  "|---|---|---|---|---|---|---|---|---|",
  ...txs.map((t, i) => `| ${i + 1} | ${wat(t.ts)} | ${t.kind} | ${t.side ?? "-"} | ${t.qty ?? "-"} | ${f(t.price, 1)} | ${t.status}${t.error ? `: ${t.error}` : ""} | ${t.reason ?? "-"} | ${link(t.tx_hash)} |`),
  "",
  "Raw log: `evidence/txs.jsonl`.",
  "",
];
writeFileSync("EVIDENCE.md", out.join("\n"));
console.log(`EVIDENCE.md written: ${onchain.length} on-chain txs, ${guard.length} guard actions, ${decisions.length} strategy signals`);
