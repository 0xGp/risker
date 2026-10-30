import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const key = generatePrivateKey();
console.log("Fresh bot key (put the KEY in .env as BOT_PRIVATE_KEY, never in Telegram or git):");
console.log(`BOT_PRIVATE_KEY=${key}`);
console.log(`Bot address (paste this in the app: wallet → Link a bot → Perps): ${privateKeyToAccount(key).address}`);
console.log("Fund the bot address with a little STT for gas (0.5 STT lasts a long time).");
