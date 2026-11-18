# Changelog

## 0.2.0

**Subagents**
- The team view: one dot per subagent on a card (green passed, red did not pass, yellow at work), and when the card is opened one line per subagent with its role, model, time and the gist of its answer. Understands superpowers' implementer statuses and reviewer verdicts, counts rounds when a step comes back, and turns yellow when one loops.
- Subagent model rules (plugin, off by default): a model per role for Claude Code's built-in subagents when the agent chooses none. The agent's own choice and a custom agent's own model always win.

**Plans and builders**
- A plan written to a `plans` folder (as superpowers does) is noticed: `Plan ready` on the card.
- `Build` starts a background session (`claude --bg`) that carries the plan out in a git worktree of its own; its questions come to the huddle. `Build plans automatically` (off by default) does it by itself when the plan is done.
- The builder's report goes back to the planning session for review. Nothing is merged without you.
- `Send to…` hands a plan to another open session instead.

**Plugin**
- Installs as a Claude Code plugin (`/plugin install agent-huddle --marketplace Jepsterrr/agent-huddle`, then `/agent-huddle:setup`).
- The plugin's module sends the quota figures itself, so the plugin never touches `settings.json` or your status line.

**Fixes**
- Clicking the box no longer takes the focus, so Alt+Tab is not disturbed.
- A long command answered `Yes` in the editor releases its card at once instead of when it finishes.
- Questions show in the editor and the box at the same time; several come one at a time.
- Messages and prompts in the step list are formatted; background-task notices no longer look like your prompts.
- A `config.json` with a byte order mark no longer resets the settings.

## 0.1.0

First release: one card per Claude Code session, permissions and questions answered in the box, risk labels and diffs on permission cards, quota and cost in the header, Windows tray app.
