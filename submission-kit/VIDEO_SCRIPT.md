# RiskGuard: voiceover (~420 words, ≈3:00)
Replace every `{{…}}` with the numbers from the real guard tx you show on screen.

**[0:00 Hook]** At twenty-x leverage, bitcoin only has to move two and a half percent against you and you're liquidated. That can happen in one fifteen-minute candle while you're at work. RiskGuard is a Telegram bot that won't let that happen.

**[0:15 Link]** First, safety. I give the bot its own key and link it in the dreamDEX app. It can place and reduce orders for my wallet, but it can never withdraw.

**[0:40 Guard setup]** I pick a guard with buttons: Balanced, Protect mode. Before anything is armed, it shows me the exact bitcoin prices where it will warn me, trim my position, and close it, and where I'd be liquidated.

**[1:10 Adopt]** Now I trade the way I always do, in the dreamDEX app. Twenty-x long. A second later the bot has adopted it: "Watching your twenty-x long," with my trigger prices.

**[1:30 Save]** Here's the part that matters. The bot doesn't poll. Somnia Reactivity pushes my margin state to it every time the price feed updates. Bitcoin drops. Health is {{HEALTH_BEFORE}} times maintenance. The guard sells {{TRIM_PCT}} percent, reduce-only. Health is back to {{HEALTH_AFTER}}, and my liquidation price moved {{LIQ_GAINED}} dollars further away. Here's the transaction on the Somnia explorer, and a card I can share.

**[2:15 Strategy]** If I want, a simple fifteen-minute strategy can trade for me too: Breakout or Trend, set with buttons. No AI in the loop: same candle, same settings, same decision, and every message shows its reason. The guard always outranks it, and it never touches a position I opened myself.

**[2:40 Close]** Trade in the app. RiskGuard keeps you alive. Everything's in the repo, with every transaction hash. Built on dreamDEX and Somnia.
