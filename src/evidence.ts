import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Store, TxRow } from "./db.js";

/** Every order the bot sends (or would send in DRY_RUN) goes to SQLite and an append-only JSONL. */
export function recordTx(store: Store, evidenceDir: string, row: TxRow & { extra?: Record<string, unknown> }): void {
  const { extra, ...tx } = row;
  store.insertTx(tx);
  mkdirSync(evidenceDir, { recursive: true });
  appendFileSync(join(evidenceDir, "txs.jsonl"), `${JSON.stringify({ ...tx, ...extra, iso: new Date(tx.ts).toISOString() })}\n`);
}
