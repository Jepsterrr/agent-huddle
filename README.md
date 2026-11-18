# Agent Huddle

A small always-on-top box where every Claude Code agent gets its own buddy, so you can see what they are doing even when VS Code is minimised.

- **One card per session** with its own buddy, what the agent is doing right now and a progress bar. If the agent keeps a task list you see `3/5` and the current task; otherwise just that it is working.
- **Click a card** to see exactly what the agent does, step by step. The agent's answers are shown with light formatting (bold, code, lists). Notices that a background agent has finished show as a grey line, not as something you wrote.
- **Subagents:** when an agent works through subagents (an implementer, a reviewer, an explorer, as in the superpowers skills), the card shows one small dot per subagent: green passed, red did not pass, yellow at work. The line under the name says who is working, on which model, and which round it is when a step comes back (an implementer fixing what a reviewer found). It turns yellow when the same step has come round three times. Open the card for one line per subagent with its model, time and the gist of its answer; click a line for the whole answer. Like the risk label, this is a reading for you and never changes what the agents do.
- **Plans get built in the background:** when a session writes a plan (a Markdown file in a `plans` folder, as superpowers does in `docs/superpowers/plans/`, or a plan from plan mode), its card says `Plan ready` when it is done. Open the card and click `Build`, or turn on `Build plans automatically` in Settings (off by default): Huddle starts a background Claude Code session (`claude --bg`, named `build: <plan>`) in the same folder that carries out the plan.
  - The builder works in a git worktree of its own before it changes files, so your working copy is untouched; nothing is merged without you.
  - Its permission questions come to the huddle, on its own card. Its subagents show there too.
  - When it is done, its report (what it built, how it tested it, its branch) goes back to the planning session as a prompt, so that session can review it and suggest how to merge. Without the plugin in the planning session, or when it was closed before the builder finished, the report is on the builder's card.
  - The builder is asked to work subagent-driven when its skills allow (as superpowers recommends: a fresh subagent per task, reviewed before the next), so its work shows in its team view.
  - One builder at a time; the automatic start waits when a quota is at 90 %. `Stop` on the planner's card ends the builder (`claude stop`).
  - Only a plan saved in a `plans` folder starts a builder by itself, and only when its session did not go on to carry it out (change files, or start subagents that build). A plan from plan mode (which its own session carries out once you approve it), or a file that only has "plan" in its name, gets `Build` on its card instead.
  - `Send to…` hands the plan to another open session with the plugin instead, as a prompt there.
- **Subagent models (plugin, off by default):** turn on `Choose subagent models` in Settings and pick a model per role (Explore & search, Plan, Implement, Test, Review) by clicking it. It only applies to Claude Code's built-in subagents (general-purpose, Explore, Plan) when the agent gives them no model itself; the agent's own choice always wins, and custom or plugin agents keep the model their own definition sets. The team list marks a model a rule chose with `(rule)`. The roles are the ones the team list shows, so a rule hits exactly what you see there.
- **Permissions:** `Allow`, `Always`, `Deny` or `In VS Code` (`In terminal` when the agent runs in one) appear right in the card, compactly: the risk label, one line showing the command or file, and the buttons on one row. Click the line to see the whole command or the diff, so several waiting agents still fit on screen. `Always` is offered when Claude Code suggests a rule; hover over it, or open the line, to see exactly what it adds.
- **Risk on permissions:** every permission request gets a coloured label (grey `No known risks`, yellow `Medium risk`, red `High risk`) and the shortest reasons, such as `deletes recursively` or `writes outside the project`. The label is **information only**: it never allows or denies anything by itself. It is based on patterns in the command and the paths, so grey means "no known pattern", not "safe". Deleting, copying or moving outside the project is red, and `cd` is followed through a chain of commands. Text in commit messages and `echo` is not read as a command, and a `cd` within the project or a pipe into `head`/`Select-Object` does not count as a chain. What it deliberately does not catch (variables, scripts, `npm run`, writes by other commands, and more) is listed at the top of `src/risk.js`.
- **Diffs for file changes:** `Edit` and `Write` show a compact diff, at most 20 lines, with `Show all` for the rest. `Write` is compared with the file on disk (read locally, at most 512 kB). The contents of `.env`, keys and similar files are never shown.
- **Questions:** pick an option (its description shows on hover), or `Other…` for your own answer, and send. Several questions come one at a time (`1/3`): a pick moves on, `Back` goes back, and `Send` comes with the last one. The question is shown in the agent's own window at the same time, and whoever answers first wins.
- **The arrow** brings up the agent's own window, whether that is VS Code, a terminal or another editor. **The cross** on a card removes the agent.
- **Quota and cost:** under the header you see how much of the 5-hour and weekly limits is used (`5h`, `7d`), with the reset time on hover. The bar turns orange at 80 % and red at 95 %, and the tray icon turns red at 90 % (unless an agent is waiting on you). The cost of the sessions shown is on the right.
- **Header:** sound on/off (chimes when an agent needs you or is done), gear for settings, fold into a thin bar, and a cross that minimises to the tray.
- **Settings** (the gear, or `Settings…` in the tray menu): sound, when the box hides, screen-sharing protection, quota bar, warning near the limit, building plans automatically, do not disturb, start with Windows and subagent models. Everything is saved straight away in `~/.agent-huddle/config.json` and survives a restart.
- **Tray:** the app lives there and only quits through `Quit` in the icon's menu. The icon is grey at rest, yellow while agents work, orange when someone needs you and red near a quota limit. A click brings back a minimised box, a right-click opens the menu. Windows puts new icons behind the `^` arrow; drag it out to the taskbar if you want to see it all the time.
- **Move** the box by dragging the header. It remembers where you put it.

## Getting started

Agent Huddle runs on Windows and needs [Node.js](https://nodejs.org) 18 or later on your `PATH`. Tested with Claude Code 2.1.322.

### As a Claude Code plugin

```
/plugin install agent-huddle --marketplace Jepsterrr/agent-huddle
/agent-huddle:setup
```

The one-step install needs Claude Code 2.1.275 or later. On older versions, add the marketplace first:

```
/plugin marketplace add Jepsterrr/agent-huddle
/plugin install agent-huddle@agent-huddle
/agent-huddle:setup
```

The plugin brings the hooks, and a small module that passes your quota and cost to the app, so it never touches your `settings.json` or your status line. `/agent-huddle:setup` is needed once: it downloads the Electron runtime the app runs on (about 100 MB to download, 360 MB on disk, kept in the plugin's data folder so plugin updates do not download it again) and starts the app. Until you have run it, a new session reminds you at most once a day. Nothing is downloaded before you run it.

After an update to a new Electron version, run `/agent-huddle:setup` again. To remove the plugin: `claude plugin uninstall agent-huddle` (this also removes the Electron runtime it downloaded). Huddle's own settings stay in `~/.agent-huddle`; delete that folder too if you want nothing left.

The plugin's module (`hooks/huddle-mod.ts`) uses Claude Code's plugin modules (tested on 2.1.322): it sends the quota figures, applies your subagent model rules when you turn them on (the app writes them to `~/.agent-huddle/routing.json`), and every few seconds asks the app whether you sent this session a plan, which it then submits as a prompt. It reads files and sends to `127.0.0.1` only; if anything in it fails, the subagent runs exactly as asked. The hooks work without it.

### From a clone

```
npm install
npm run install-hooks
npm start
```

`install-hooks` adds hooks to `~/.claude/settings.json` (a backup is saved as `settings.json.huddle-backup`). Sessions that are already running may need a restart to show up. If you also have the plugin installed, the plugin's hooks stay quiet so nothing is reported twice.

Try it without Claude Code: start the app and run `npm run demo`. Three fake agents show a permission request, a question, and a team of subagents with a review that does not pass the first time.

## Good to know

- **The app starts by itself** when a Claude Code session starts, if it is not already running. So `npm start` is only needed if you want it up in advance.
- **The app is never in the way.** If it cannot be reached, the hook script exits at once without a word, and Claude Code asks as usual.
- **The box only shows when it is needed.** It hides while you are in the agent's own window, when there are no agents, and while something runs full-screen (a film, a game, a presentation). With several agents in different windows the box stays until you are with all of them, so you do not miss the others.
- **A minimised box** comes back when an agent waits for an answer. If you do not want to be disturbed at all, choose `Do not disturb` in the menu: the box stays hidden and every question is asked in the editor. A background builder has no window of its own to ask in, so in `Do not disturb` (or with the app closed) its questions are refused and it stops where it needs you.
- **Hidden from screen sharing.** The box is invisible to screen sharing, recordings and screenshots. You can turn that off in the menu.
- **You answer where you are.** A permission request is always in two places at once: in the agent's own window and in the box. Whoever answers first wins, and the other place lets go by itself. If you answer `Yes` in VS Code to a command that takes a long time, the card still disappears within a couple of seconds: the app sees that Claude Code has started the command (a new shell under the agent's process). If you walk away mid-question, the buttons stay in the box.
- **Agents that died** (crash, closed window) are cleaned up by themselves within ten seconds.
- **Plans** (plan mode) are always approved in the editor. The buddy only shows that the agent is waiting.
- **If you move the folder** (clone install) you must run `npm run install-hooks` again, since the hook points to `hooks/hook.js` here.
- **The hooks never download anything.** If the Electron runtime is missing, the app simply is not started.
- If `npm start` complains that Electron is missing: run `node node_modules/electron/install.js`.

Uninstall the hooks (clone install): `npm run uninstall-hooks`. Huddle's own settings stay in `~/.agent-huddle`; delete that folder too if you want nothing left.

## Quota and cost

Claude Code knows your quota and the session's cost after each answer. Huddle gets them one of two ways:

- **Plugin:** the plugin's module (`hooks/huddle-mod.ts`) receives them after each turn and sends them to the app. Nothing in your settings changes, and your status line stays yours.
- **Clone:** `install-hooks` adds a `statusLine` to `~/.claude/settings.json` that points to `hooks/hook.js status`. Claude Code runs it after every answer.

Either way:

- **Only numbers are sent:** session id, cost, how full the context is, and the quota windows. Paths, model and everything else stay behind. It all goes to `127.0.0.1` with the same token as the hooks. Nothing goes out to the internet.
- **The quota is only there for claude.ai Pro, Max and Ultra**, and only after the session's first answer. With an API key only the cost is shown.

For the clone's status line:

- **The status line in the terminal stays empty.** The script never prints anything there.
- **If you already have your own `statusLine`**, `install-hooks` leaves it alone, and the quota will then not show in the box. There is only one `statusLine`, and Huddle does not chain them together automatically. (The plugin has no such limit.)
- If you do not want the bridge: `npm run install-hooks -- --no-statusline`. Removing only ever takes out Huddle's own status line.
- `statusLine` has no exec form, so the command is run by a shell (Git Bash, otherwise PowerShell). It is written as `node "C:/path/hooks/hook.js" status`, which works in both and copes with spaces in the path.

## How it works

```
Claude Code ──hook──────> hooks/hook.js ─────┐
            ──module────> hooks/huddle-mod.ts ┼──HTTP (127.0.0.1 + token)──> src/server.js
            <─prompt──────(plans, reports)────┘                                   │
                                     src/store.js  (sessions, steps, team, plans, waiting requests)
                                                                                  │
            claude --bg <──── src/main.js (builders) ──IPC──> src/renderer (the box)
```

When it starts, the app writes its port and a random token to `~/.agent-huddle/runtime.json`. The hook script reads that file and forwards every event. For permissions and questions the server holds the call until you have clicked, and your answer becomes the hook's decision. The plugin's module uses the same file and token for the quota figures, the model rules (`routing.json`) and plans or reports waiting for its session. Builders are started by the app with `claude --bg` and report through the same hooks as any other session.

| File | What it does |
|---|---|
| `hooks/hook.js` | The hook script: forwards events, holds permissions and questions, starts the app |
| `hooks/huddle-mod.ts` | The plugin's module: quota, model rules, plans and reports into a session |
| `src/store.js` | Sessions, steps, the team, plans and builds, built from events |
| `src/risk.js`, `src/diff.js` | Risk labels and diffs for permission cards |
| `src/team.js`, `src/routing.js` | Subagent roles and verdicts; model rules |
| `src/builder.js` | Starting and following background builders |
| `src/main.js`, `src/renderer/` | The Electron app and the box |

Tests: `npm test`.

Troubleshooting: if you start the app with the environment variable `HUDDLE_DEBUG_EVENTS=1`, it writes `~/.agent-huddle/events.log` with which events arrive and which fields they have (name, tool, whether `agent_id` is present, the names of a tool's input and result fields). Never values: no commands, file contents, paths or tokens. Off by default.
