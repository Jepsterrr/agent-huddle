# Changelog

## 0.2.1

**Requirements**
- Node.js 22.12 or later (was 18), which Electron's installer already needed. Node 18 and 20 are out of support. CI now tests on the oldest allowed Node and on a current one.

**Fixes**
- `install-hooks` no longer overwrites `settings.json.huddle-backup` on every run: the first run's backup of the original is kept, so a second run cannot replace it with a copy that already has Huddle's hooks.
- A plan with no file of its own (plan mode) is saved to `~/.agent-huddle/plans/` and the builder gets its path, instead of the whole text on the command line, which Windows cuts at about 32,000 characters.
- The hook no longer trusts a `runtime.json` left by an app that crashed: unless its pid is alive, nothing is sent, so another program that happens to get the same port never receives the token or a permission request.
- A Write's diff no longer shows a secret file reached through a symlink or a folder junction: the link's target is checked, not only its name.

**Risk labels**
- Deleting only build output inside the project (`rm -rf node_modules`, `dist`, `build`, `.next` …) is medium (`deletes build output`), not high. Anything more in the same line, a `cd`, a wildcard, a variable or a path outside the project keeps it high.
- `sed -i` is checked like other writes: outside the project or into a secrets file is high.
- A shell call with no command is medium (`no command to judge`) instead of a silent low.
- Writing `.claude/settings.json` gives one reason (`changes Claude settings`) instead of overlapping ones.

**Plugin**
- The plugin and hook descriptions now say that the module submits a plan you send from another session's card as a prompt in that session.
- The module's decisions (which subagent gets which model, what goes to the app, what counts as a plan in the inbox) moved to `hooks/mod-logic.mjs`, and are now tested by running them, as is the module's `register()` with a stand-in for Claude Code. Before, the tests only read the module's source.
- The inbox timer is cancelled at the end of a session and never doubled if a session starts twice in one process.

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
