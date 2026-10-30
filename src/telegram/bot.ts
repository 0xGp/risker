import { Bot, InlineKeyboard, type Context } from "grammy";
import { hx, px, type App, type Button, type Notifier } from "../app.js";
import { txUrl, type Config } from "../config.js";
import { dayWat } from "../db.js";
import { health, triggers } from "../guard/trigger.js";
import { CHOICES, defaultParams, derivedRisk, PRESETS, validateParams, type Preset, type StrategyParams } from "../params.js";
import { GUARD_PROFILES, GuardRulesSchema, makeRules, PROFILE_DEFAULTS, updateRules, type GuardMode, type GuardProfile, type GuardRules } from "../rules.js";

const KEY_PATTERN = /(?:0x)?[0-9a-fA-F]{64}\b/;
const DISCLAIMER = "Testnet only, not financial advice. The bot key can place and reduce orders for your account; it can never withdraw.";

export function keyboard(rows: Button[][]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const row of rows) {
    for (const b of row) b.url ? kb.url(b.text, b.url) : kb.text(b.text, b.data ?? "noop");
    kb.row();
  }
  return kb;
}

const PARAM_LABELS: Record<keyof typeof CHOICES, (v: number | string) => string> = {
  sizeUsd: (v) => `$${v}`,
  leverage: (v) => `${v}x`,
  tpPct: (v) => `TP ${v}%`,
  slPct: (v) => `SL ${v}%`,
  maxTradesPerDay: (v) => `${v}/day`,
  dailyLossLimitUsd: (v) => `-$${v}`,
  direction: (v) => String(v),
};

export function createTelegram(cfg: Config, getApp: () => App | null) {
  if (!cfg.telegramToken) throw new Error("TELEGRAM_BOT_TOKEN is not set.");
  const bot = new Bot(cfg.telegramToken);
  const guardDraft = new Map<number, { profile: GuardProfile; mode: GuardMode }>();
  const stratDraft = new Map<number, StrategyParams>();
  const pendingRules = new Map<number, { kind: "guard"; rules: GuardRules } | { kind: "strategy"; params: StrategyParams }>();

  const app = () => {
    const a = getApp();
    if (!a) throw new Error("still connecting to the chain, try again in a few seconds");
    return a;
  };

  bot.on("message:text", async (ctx, next) => {
    if (KEY_PATTERN.test(ctx.message.text)) {
      await ctx.deleteMessage().catch(() => undefined);
      await ctx.reply("🔒 Deleted a message that looked like a private key. Never send keys here; RiskGuard only needs your wallet ADDRESS.");
      return;
    }
    await next();
  });

  bot.use(async (ctx, next) => {
    const id = ctx.chat?.id;
    if (id === undefined || !cfg.allowedChatIds.includes(id)) {
      if (ctx.message) await ctx.reply(`This RiskGuard deployment is private. Your chat id is ${id}; add it to ALLOWED_CHAT_IDS to use it.`);
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Not allowed" });
      return;
    }
    try {
      await next();
    } catch (err) {
      await ctx.reply(`⚠️ ${(err as Error).message}`).catch(() => undefined);
    }
  });

  bot.command("start", async (ctx) => {
    const a = getApp();
    const botAddr = a?.c.tradingKey?.operator ?? "(set BOT_PRIVATE_KEY)";
    await ctx.reply(
      [
        "🛡️ RiskGuard keeps your dreamDEX BTC-PERP position from being liquidated.",
        "Trade in the app as usual. RiskGuard watches your account through Somnia Reactivity on every price update, warns you, trims and, as a last resort, closes before liquidation.",
        "",
        `1. In app.testnet.dreamdex.io → wallet → Link a bot → tick Perps → paste: ${botAddr}`,
        `2. /link to check the link for ${cfg.owner}`,
        "3. /guard to pick your protection",
        "4. Optional: /strategy for a 15-minute auto-strategy",
        "",
        DISCLAIMER,
      ].join("\n"),
    );
  });

  bot.command("link", async (ctx) => {
    const a = app();
    const { linkOk } = await import("../chain.js");
    a.link = await linkOk(a.c);
    const l = a.link;
    await ctx.reply(
      l.ok
        ? `✅ Bot ${a.c.tradingKey?.operator} is linked to ${cfg.owner} on BTC-PERP (place ${l.place ? "✓" : "✗"}, cancel ${l.cancel ? "✓" : "✗"}, reduce ${l.reduce ? "✓" : "✗"}).`
        : `❌ Not linked yet. In the app: wallet → Link a bot → tick Perps → paste ${a.c.tradingKey?.operator ?? "the bot address"}. Then /link again.`,
    );
  });

  // ----- guard -----
  const profileKb = () => keyboard([GUARD_PROFILES.map((p) => ({ text: p === "balanced" ? "Balanced ★" : p[0]!.toUpperCase() + p.slice(1), data: `g:p:${p}` }))]);

  bot.command("guard", async (ctx) => {
    const arg = ctx.match.trim().toLowerCase();
    const a = app();
    if (arg === "off") return void ctx.reply("Turn the guard OFF? Nothing will protect your position.", { reply_markup: keyboard([[{ text: "Yes, turn off", data: "g:off" }, { text: "Cancel", data: "g:x" }]]) });
    if (arg === "on") {
      a.setRules({ ...a.rules, enabled: true });
      return void ctx.reply("🛡️ Guard ON.");
    }
    const lines = Object.entries(PROFILE_DEFAULTS).map(([k, d]) => `• ${k}: warn ${d.warnHealth} · trim ${d.trimPct}% at ${d.trimHealth} · flatten at ${d.flattenHealth}`);
    await ctx.reply(`Pick a protection profile (health = equity ÷ maintenance margin, 1.0 = liquidation):\n${lines.join("\n")}`, { reply_markup: profileKb() });
  });

  bot.callbackQuery(/^g:p:(\w+)$/, async (ctx) => {
    const profile = ctx.match[1] as GuardProfile;
    guardDraft.set(ctx.chat!.id, { profile, mode: "protect" });
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`Profile: ${profile}. What should the guard do when a level is hit?`, {
      reply_markup: keyboard([[{ text: "Protect (act automatically) ★", data: "g:m:protect" }], [{ text: "Alert only (buttons)", data: "g:m:alert" }]]),
    });
  });

  bot.callbackQuery(/^g:m:(protect|alert)$/, async (ctx) => {
    const draft = guardDraft.get(ctx.chat!.id);
    if (!draft) return void ctx.answerCallbackQuery({ text: "Start again with /guard" });
    draft.mode = ctx.match[1] as GuardMode;
    const rules = makeRules(draft.profile, draft.mode);
    const a = app();
    const snap = a.lastSnap;
    const trig = snap?.position
      ? (() => {
          const t = triggers(snap, rules);
          return `For your current ${snap.position.side} (health ${hx(health(snap))}):\nWarn ≈ ${px(t.warn)} · Trim ${rules.trimPct}% ≈ ${px(t.trim)} · Flatten ≈ ${px(t.flatten)} · Liq ≈ ${px(t.liq)}`;
        })()
      : "No BTC-PERP position right now: trigger prices appear when you open one.";
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      [
        `🛡️ Confirm guard: ${rules.profile}, ${rules.mode === "protect" ? "auto-protect" : "alert only"}`,
        `Warn + block entries below ${rules.warnHealth} · trim ${rules.trimPct}% below ${rules.trimHealth} · close all below ${rules.flattenHealth}`,
        `Also acts when liquidation is within ${rules.atrTrimMult}× / ${rules.atrFlattenMult}× the 15m ATR${a.atr ? ` (now ${a.atr.toFixed(2)}%)` : ""}.`,
        trig,
        "Reduce-only: the guard never opens, adds or flips.",
      ].join("\n"),
      { reply_markup: keyboard([[{ text: "✅ Arm", data: "g:arm" }, { text: "✏️ Edit", data: "g:edit" }, { text: "✖ Cancel", data: "g:x" }]]) },
    );
  });

  bot.callbackQuery("g:arm", async (ctx) => {
    const draft = guardDraft.get(ctx.chat!.id);
    if (!draft) return void ctx.answerCallbackQuery({ text: "Start again with /guard" });
    const v = app().setRules(makeRules(draft.profile, draft.mode));
    guardDraft.delete(ctx.chat!.id);
    await ctx.answerCallbackQuery({ text: "Armed" });
    await ctx.editMessageText(`🛡️ Guard armed: ${draft.profile}, ${draft.mode} (rules v${v}).`);
  });
  bot.callbackQuery("g:edit", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Pick a protection profile:", { reply_markup: profileKb() });
  });
  bot.callbackQuery("g:off", async (ctx) => {
    const a = app();
    a.setRules({ ...a.rules, enabled: false });
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Guard OFF. /guard on to re-enable.");
  });
  bot.callbackQuery("g:x", async (ctx) => {
    guardDraft.delete(ctx.chat!.id);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Cancelled.");
  });

  // ----- status / close / panic / snooze -----
  bot.command("status", async (ctx) => void (await ctx.reply(app().statusText(), { link_preview_options: { is_disabled: true } })));

  bot.command("close", async (ctx) => {
    const pct = Number(ctx.match.trim() || 100);
    if (!(pct > 0 && pct <= 100)) return void ctx.reply("Usage: /close [1-100] (percent of the position)");
    await ctx.reply(`Close ${pct}% of your BTC-PERP position?`, { reply_markup: keyboard([[{ text: `Yes, close ${pct}%`, data: `close:${pct}` }, { text: "Cancel", data: "ignore" }]]) });
  });

  bot.callbackQuery(/^close:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Sending…" });
    const pct = Number(ctx.match[1]);
    const res = await app().manualClose(pct, "manual-close");
    if (!res) return void ctx.reply("No BTC-PERP position to close.");
    await ctx.reply(`${res.status === "filled" ? "✅" : "⚠️"} Close ${pct}%: ${res.status}${res.detail ? ` (${res.detail})` : ""}${res.hash ? `\ntx: ${txUrl(cfg, res.hash)}` : ""}`, { link_preview_options: { is_disabled: true } });
  });

  bot.command("panic", async (ctx) => {
    await ctx.reply("🚨 PANIC: cancel all BTC-PERP orders and close the whole position?", { reply_markup: keyboard([[{ text: "🚨 Yes, close everything", data: "panic" }, { text: "Cancel", data: "ignore" }]]) });
  });
  bot.callbackQuery("panic", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Closing…" });
    const { close, cancelled } = await app().panic();
    await ctx.reply(`🚨 Panic: cancelled ${cancelled} orders; close ${close ? close.status : "nothing open"}${close?.hash ? `\ntx: ${txUrl(cfg, close.hash)}` : ""}`, { link_preview_options: { is_disabled: true } });
  });

  const snoozeIt = async (ctx: Context) => {
    app().snoozeTrims(15);
    await ctx.reply("😴 Trims snoozed for 15 minutes. Flatten stays active.");
  };
  bot.command("snooze", snoozeIt);
  bot.callbackQuery("snooze", async (ctx) => {
    await ctx.answerCallbackQuery();
    await snoozeIt(ctx);
  });
  bot.callbackQuery(["ignore", "noop"], (ctx) => ctx.answerCallbackQuery());

  // ----- strategy -----
  const strategyEditor = (p: StrategyParams) => {
    const rows: Button[][] = [];
    for (const field of Object.keys(CHOICES) as (keyof typeof CHOICES)[]) {
      rows.push(
        (CHOICES[field] as readonly (number | string)[]).map((v) => ({
          text: `${PARAM_LABELS[field](v)}${p[field] === v ? " ✓" : ""}`,
          data: `s:set:${field}:${v}`,
        })),
      );
    }
    rows.push([{ text: "Review ▶", data: "s:review" }, { text: "✖ Cancel", data: "s:x" }]);
    return keyboard(rows);
  };
  const editorText = (p: StrategyParams) =>
    `🤖 ${p.preset === "breakout" ? "Breakout: close beyond the prior 1h high/low ± 0.05%" : "Trend: EMA9 crosses EMA21 on 15m closes"}\nRows: size · leverage cap · take-profit · stop-loss · max trades/day · daily loss limit · direction`;

  bot.command("strategy", async (ctx) => {
    await ctx.reply("Pick a 15-minute strategy (it runs under the guard and never touches positions you opened yourself):", {
      reply_markup: keyboard([PRESETS.map((p) => ({ text: p === "breakout" ? "Breakout" : "Trend follow", data: `s:p:${p}` }))]),
    });
  });
  bot.callbackQuery(/^s:p:(\w+)$/, async (ctx) => {
    const p = defaultParams(ctx.match[1] as Preset);
    stratDraft.set(ctx.chat!.id, p);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(editorText(p), { reply_markup: strategyEditor(p) });
  });
  bot.callbackQuery(/^s:set:(\w+):([\w.]+)$/, async (ctx) => {
    const p = stratDraft.get(ctx.chat!.id);
    if (!p) return void ctx.answerCallbackQuery({ text: "Start again with /strategy" });
    const field = ctx.match[1] as keyof typeof CHOICES;
    const raw = ctx.match[2]!;
    const next = { ...p, [field]: field === "direction" ? raw : Number(raw) } as StrategyParams;
    stratDraft.set(ctx.chat!.id, next);
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: strategyEditor(next) });
  });
  bot.callbackQuery("s:review", async (ctx) => {
    const p = stratDraft.get(ctx.chat!.id);
    if (!p) return void ctx.answerCallbackQuery({ text: "Start again with /strategy" });
    let valid: StrategyParams;
    try {
      valid = validateParams(p, cfg.maxOrderUsd);
    } catch (err) {
      return void ctx.answerCallbackQuery({ text: (err as Error).message.slice(0, 190), show_alert: true });
    }
    const r = derivedRisk(valid);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      [
        `🤖 Confirm ${valid.preset}: $${valid.sizeUsd} per trade, ${valid.direction}`,
        `TP ${valid.tpPct}% · SL ${valid.slPct}% (bot-side) · max ${valid.maxTradesPerDay} trades/day · stop for the day at -$${valid.dailyLossLimitUsd}`,
        `Leverage cap ${valid.leverage}x: margin ≈ $${r.marginUsd.toFixed(2)}, liquidation ≈ ${r.liqDistancePct.toFixed(1)}% away at that leverage`,
        `Worst loss per trade ≈ $${r.worstLossPerTradeUsd.toFixed(2)} · daily cap $${r.dailyCapUsd}`,
        "Decides once per closed 15m candle, from the next candle on. The guard outranks it.",
      ].join("\n"),
      { reply_markup: keyboard([[{ text: "✅ Arm", data: "s:arm" }, { text: "✏️ Edit", data: "s:edit" }, { text: "✖ Cancel", data: "s:x" }]]) },
    );
  });
  bot.callbackQuery("s:edit", async (ctx) => {
    const p = stratDraft.get(ctx.chat!.id);
    await ctx.answerCallbackQuery();
    if (p) await ctx.editMessageText(editorText(p), { reply_markup: strategyEditor(p) });
  });
  bot.callbackQuery("s:arm", async (ctx) => {
    const p = stratDraft.get(ctx.chat!.id);
    if (!p) return void ctx.answerCallbackQuery({ text: "Start again with /strategy" });
    const v = app().setStrategy(validateParams(p, cfg.maxOrderUsd), true, false);
    stratDraft.delete(ctx.chat!.id);
    await ctx.answerCallbackQuery({ text: "Armed" });
    await ctx.editMessageText(`🤖 Strategy armed: ${p.preset} (v${v}). First decision at the next 15m close.${cfg.dryRun ? " DRY RUN: decisions are logged, nothing is sent." : ""}`);
  });
  bot.callbackQuery("s:x", async (ctx) => {
    stratDraft.delete(ctx.chat!.id);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Cancelled.");
  });

  bot.command(["pause", "resume"], async (ctx) => {
    const a = app();
    const s = a.strategy;
    if (!s) return void ctx.reply("No strategy set. Use /strategy.");
    const paused = ctx.message!.text.startsWith("/pause");
    a.setStrategy(s.params, s.armed, paused);
    await ctx.reply(paused ? "⏸️ Strategy paused. The guard keeps running." : "▶️ Strategy resumed.");
  });

  // ----- rules -----
  bot.command("rules", async (ctx) => {
    const a = app();
    const m = ctx.match.trim().match(/^set\s+(\w+)\s+(\S+)$/);
    if (!m) {
      const g = a.rules;
      const s = a.strategy?.params;
      return void ctx.reply(
        [
          `🛡️ Guard v${a.rulesVersion}: ${g.enabled ? "on" : "off"} · ${g.profile} · ${g.mode} · warnHealth ${g.warnHealth} · trimHealth ${g.trimHealth} · flattenHealth ${g.flattenHealth} · trimPct ${g.trimPct} · atrTrimMult ${g.atrTrimMult} · atrFlattenMult ${g.atrFlattenMult}`,
          s ? `🤖 Strategy v${a.strategy!.version}: ${Object.entries(s).filter(([, v]) => typeof v !== "object").map(([k, v]) => `${k} ${v}`).join(" · ")}` : "🤖 Strategy: not set",
          "Change one: /rules set trimHealth 1.6",
        ].join("\n"),
      );
    }
    const [, field, rawValue] = m as unknown as [string, string, string];
    const value: unknown = rawValue === "true" ? true : rawValue === "false" ? false : Number.isNaN(Number(rawValue)) ? rawValue : Number(rawValue);
    if (field in GuardRulesSchema.shape) {
      const rules = updateRules(a.rules, { [field]: value } as Partial<GuardRules>);
      pendingRules.set(ctx.chat.id, { kind: "guard", rules });
      return void ctx.reply(`Guard ${field}: ${String((a.rules as Record<string, unknown>)[field])} → ${String(value)}. Apply?`, { reply_markup: keyboard([[{ text: "✅ Apply", data: "r:ok" }, { text: "Cancel", data: "r:x" }]]) });
    }
    if (!a.strategy) throw new Error(`${field} is not a guard rule, and no strategy is set`);
    const params = validateParams({ ...a.strategy.params, [field]: value }, cfg.maxOrderUsd);
    pendingRules.set(ctx.chat.id, { kind: "strategy", params });
    await ctx.reply(`Strategy ${field}: ${String((a.strategy.params as Record<string, unknown>)[field])} → ${String(value)}. Applies from the next candle. Apply?`, { reply_markup: keyboard([[{ text: "✅ Apply", data: "r:ok" }, { text: "Cancel", data: "r:x" }]]) });
  });
  bot.callbackQuery("r:ok", async (ctx) => {
    const pending = pendingRules.get(ctx.chat!.id);
    pendingRules.delete(ctx.chat!.id);
    await ctx.answerCallbackQuery();
    if (!pending) return;
    const a = app();
    const v = pending.kind === "guard" ? a.setRules(pending.rules) : a.setStrategy(pending.params, a.strategy?.armed ?? false, a.strategy?.paused ?? false);
    await ctx.editMessageText(`✅ Applied (v${v}).`);
  });
  bot.callbackQuery("r:x", async (ctx) => {
    pendingRules.delete(ctx.chat!.id);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Cancelled.");
  });

  // ----- history / stats -----
  bot.command("history", async (ctx) => {
    const rows = app().store.recentTxs(10);
    if (!rows.length) return void ctx.reply("No actions yet.");
    const lines = rows.map((t) => `${new Date(t.ts + 3_600_000).toISOString().slice(5, 16).replace("T", " ")} ${t.kind} ${t.side ?? ""} ${t.qty ? `${t.qty} BTC` : ""} · ${t.status}${t.tx_hash ? `\n  ${txUrl(cfg, t.tx_hash)}` : ""}`);
    await ctx.reply(lines.join("\n"), { link_preview_options: { is_disabled: true } });
  });
  bot.command("stats", async (ctx) => {
    const a = app();
    const s = a.store.stats();
    const d = a.store.day(dayWat(Date.now()));
    const text = `📊 Today: ${d.guard_saves} guard saves · ${d.trades} strategy trades · realized $${d.realized_pnl.toFixed(2)}\nAll time: ${s.guardSaves} guard saves · ${s.strategyTrades} strategy trades · ${s.txs} on-chain txs · strategy PnL $${s.realized.toFixed(2)}`;
    const share = `My RiskGuard on @DreamDEXSomnia: ${s.guardSaves} liquidation saves, ${s.txs} on-chain actions 🛡️`;
    await ctx.reply(text, { reply_markup: keyboard([[{ text: "Share on X", url: `https://twitter.com/intent/tweet?text=${encodeURIComponent(share)}` }]]) });
  });

  const notifier: Notifier = {
    async send(text, buttons) {
      for (const chatId of cfg.allowedChatIds) {
        await bot.api
          .sendMessage(chatId, text, { reply_markup: buttons?.length ? keyboard(buttons) : undefined, link_preview_options: { is_disabled: true } })
          .catch((err) => console.log(`telegram send to ${chatId} failed: ${(err as Error).message}`));
      }
    },
  };

  const commands = [
    ["start", "Set up RiskGuard"],
    ["link", "Check the bot link"],
    ["guard", "Pick protection (on/off)"],
    ["status", "Position, health, trigger prices"],
    ["close", "Close part or all [pct]"],
    ["panic", "Close everything now"],
    ["snooze", "Snooze trims 15 min"],
    ["strategy", "Optional 15m strategy"],
    ["pause", "Pause the strategy"],
    ["resume", "Resume the strategy"],
    ["rules", "Show or set rules"],
    ["history", "Last 10 actions"],
    ["stats", "Saves, trades, PnL"],
  ].map(([command, description]) => ({ command: command!, description: description! }));

  return { bot, notifier, commands };
}
