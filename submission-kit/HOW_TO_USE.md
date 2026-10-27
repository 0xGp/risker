# How to use this submission kit
Repo: https://github.com/0xGp/risker. Copy `submission-kit/README.md` over the root `README.md` once the code exists; keep the other files here (`SUBMISSION.md` is paste-ready text for DoraHacks). Feedback-track files live in the root `feedback/` folder. Find every gap with `grep -rn "{{" submission-kit/ feedback/`.

| When | Fill in |
|---|---|
| **Today (Tue Oct 27)** | Get your DoraHacks email whitelisted (Discord ticket or SomniaHacks Telegram). `{{BOT_WALLET_ADDRESS}}`, `{{OWNER_WALLET_ADDRESS}}`; first evidence row from the spike (bot reduces a manual position) |
| Each time you hit an SDK snag | A new `feedback/NNN-*.md` right away (error text and tx hash while they're fresh), plus a row in SDK_FEEDBACK.md |
| Wed Oct 28 (guard live) | First real guard trim on a 15–20x manual position → `{{HEALTH_BEFORE}}`, `{{HEALTH_AFTER}}`, `{{LIQ_BEFORE}}`, `{{LIQ_AFTER}}`, `{{EXPLORER_TX_GUARD}}`; record the screen while waiting for it |
| Fri Oct 30 (features frozen) | `{{TEST_COUNT}}`, `{{TX_COUNT}}`, `{{GUARD_TX_COUNT}}`, `{{STRATEGY_TX_COUNT}}`, evidence table (from `npm run evidence`), screenshots, single vs multi-tenant wording, honest-status lists |
| Sat Oct 31 | Record using DEMO.md + VIDEO_SCRIPT.md → `{{DEMO_VIDEO_URL}}`, thumbnail; post the 3 X posts → `{{X_POST_n_URL}}` |
| Nov 1 before 20:00 WAT | `{{BOUNTY_SLUG}}`, `{{AI_TOOLS_USED}}`; check every link in an incognito window; delete `feedback/001-example.md` if unused; submit SUBMISSION.md |

Rule: never claim something the evidence doesn't show. Every number in a post, the video or the README comes from a real tx. If it isn't built, it goes under "Not built".
