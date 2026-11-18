// Starting a background builder session for a finished plan:
//   claude --bg --name "build: <plan>" --permission-mode default [--model m] "<prompt>"
// Measured on Claude Code 2.1.322: a background session shows up in the
// huddle through the usual hooks, works in a git worktree of its own before
// it changes files, and in "default" mode its permission questions come to
// the huddle (it has no dialog of its own). `claude agents --json` lists it
// with its session id; `claude stop <id>` ends it. No Electron in here.

const fs = require('fs');
const path = require('path');

// The real claude executable. On Windows `claude` on PATH is often an npm shim
// (claude.ps1 / claude.cmd) that cannot be started without a shell.
function findClaude(env = process.env, exists = fs.existsSync) {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const candidates = [
    ...dirs.map((d) => path.join(d, exe)),
    env.APPDATA && path.join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe),
    env.USERPROFILE && path.join(env.USERPROFILE, '.local', 'bin', exe),
    env.HOME && path.join(env.HOME, '.local', 'bin', exe),
  ].filter(Boolean);
  return candidates.find((p) => exists(p)) || null;
}

// The environment for the builder: the app's own, without the variables of
// the Claude Code session the app happened to be started from (a builder is a
// session of its own, not a child of that one).
function builderEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^CLAUDECODE$|^CLAUDE_CODE_|^CLAUDE_PID$|^ELECTRON_RUN_AS_NODE$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// A plan with no file of its own (one from plan mode) is written to
// <dir>/plans/ first, so the builder's command line carries a path and not the
// whole text: Windows cuts a command line at about 32,000 characters.
function writePlanFile(dir, plan, now = Date.now()) {
  const slug = String(plan?.title || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'plan';
  const folder = path.join(dir, 'plans');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${slug}-${now}.md`);
  fs.writeFileSync(file, String(plan?.text || ''));
  return file;
}

// "build: retry-logic", kept short for `claude agents` and the card.
const builderName = (title) => `build: ${String(title || 'plan').slice(0, 40)}`;

function builderArgs({ title, prompt, model }) {
  const args = ['--bg', '--name', builderName(title), '--permission-mode', 'default'];
  if (model) args.push('--model', model);
  args.push(prompt);
  return args;
}

// What the builder is asked: the plan, and a report at the end that the
// planner can act on.
// Subagent-driven execution is asked for when the session has it (superpowers'
// recommended way: a fresh subagent per task, reviewed before the next), so the
// work shows in the builder's team view; without such skills it reads as advice.
function builderPrompt(planPromptText) {
  return (
    `${planPromptText}\n\n` +
    'If your skills offer subagent-driven execution (a fresh subagent per task, reviewed before the next), use it.\n\n' +
    'When you are done, end with a short report: what you built, what you tested and how, anything left open, ' +
    'and the git branch your work is on. Do not merge it.'
  );
}

// The builder's own first prompt (not a plan sent to an open session with
// "Send to…", which has no report request).
const BUILDER_MARK = 'and the git branch your work is on. Do not merge it.';
const isBuilderPrompt = (prompt) => typeof prompt === 'string' && prompt.includes(BUILDER_MARK);

// "backgrounded · ddd0cda3 · build: retry-logic" -> { id: 'ddd0cda3' }
function parseBackgrounded(text) {
  const m = /backgrounded\s*·\s*([0-9a-f]{6,})/i.exec(String(text || ''));
  return m ? { id: m[1] } : null;
}

// From `claude agents --json`: the session id of background agent `id`.
function sessionIdOf(agentsJson, id) {
  let list;
  try {
    list = JSON.parse(agentsJson);
  } catch {
    return null;
  }
  const items = Array.isArray(list) ? list : Array.isArray(list?.value) ? list.value : [];
  return items.find((a) => a && a.id === id)?.sessionId || null;
}

// What goes back to the planner when the builder is done.
function reportPrompt(title, builderMessage) {
  return (
    `The background builder for the plan "${title}" has finished. Its report:\n\n` +
    `${String(builderMessage || '(no report)').slice(0, 6000)}\n\n` +
    'Review the work on its branch against the plan, and suggest how to merge it. Do not merge without asking me.'
  );
}

module.exports = {
  findClaude,
  builderEnv,
  writePlanFile,
  builderName,
  builderArgs,
  builderPrompt,
  isBuilderPrompt,
  parseBackgrounded,
  sessionIdOf,
  reportPrompt,
};
