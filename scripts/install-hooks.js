#!/usr/bin/env node
// Adds (or with --uninstall, removes) the Agent Huddle hooks in the user-level
// Claude Code settings. Existing settings and other hooks are left alone, and a
// backup of the original file is written the first time (and then kept).
//
//   --uninstall       remove Huddle's hooks and status line
//   --no-statusline   leave the status line out (and remove ours)

const fs = require('fs');
const path = require('path');
const { settingsFile: getSettingsFile, huddleHooks, isHuddleHook, isHuddleStatus } = require('../hooks/shared');

const argv = process.argv.slice(2);
const uninstall = argv.includes('--uninstall');
const settingsFile = getSettingsFile();
const hookFile = path.resolve(__dirname, '..', 'hooks', 'hook.js');
const node = process.execPath;

// Exec form (command + args): no shell, so spaces in paths are not a problem.
const ours = huddleHooks(node, hookFile);

let settings = {};
if (fs.existsSync(settingsFile)) {
  const raw = fs.readFileSync(settingsFile, 'utf8');
  try {
    settings = JSON.parse(raw);
  } catch (err) {
    console.error(`Could not parse ${settingsFile}: ${err.message}\nNothing was changed.`);
    process.exit(1);
  }
  // Written once, before Huddle first touches the file, and never overwritten:
  // a second run would otherwise replace the original with a copy that
  // already has Huddle's hooks in it.
  const backup = `${settingsFile}.huddle-backup`;
  if (fs.existsSync(backup)) {
    console.log(`Backup kept from an earlier run: ${backup}`);
  } else {
    fs.writeFileSync(backup, raw, { flag: 'wx' });
    console.log(`Backup written to ${backup}`);
  }
} else {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
}

const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};

// Drop any earlier Huddle entries first, so re-running never duplicates them.
for (const event of Object.keys(hooks)) {
  if (!Array.isArray(hooks[event])) continue;
  hooks[event] = hooks[event]
    .map((group) => ({ ...group, hooks: (group.hooks || []).filter((h) => !isHuddleHook(h)) }))
    .filter((group) => group.hooks.length);
  if (!hooks[event].length) delete hooks[event];
}

if (!uninstall) {
  for (const [event, groups] of Object.entries(ours)) {
    hooks[event] = [...(hooks[event] || []), ...groups];
  }
}

if (Object.keys(hooks).length) settings.hooks = hooks;
else delete settings.hooks;

// ---- statusLine bridge (quota and cost in the header) ----
//
// statusLine has no exec form: `command` is run by a shell (Git Bash on
// Windows, else PowerShell). `node "C:/path with spaces/hook.js" status` works
// in both. A full node path in quotes would not run in PowerShell, so it is
// only used when node is not on PATH (Git Bash is then needed).
// There is only one statusLine: one that is not ours is never touched.
const onPath = (process.env.PATH || '')
  .split(path.delimiter)
  .some((d) => d && path.resolve(d).toLowerCase() === path.dirname(node).toLowerCase());
const fwd = (p) => p.replace(/\\/g, '/');
const statusCommand = `${onPath ? 'node' : `"${fwd(node)}"`} "${fwd(hookFile)}" status`;

let statusNote = '';
if (uninstall || argv.includes('--no-statusline')) {
  if (isHuddleStatus(settings.statusLine)) {
    delete settings.statusLine;
    statusNote = 'Status line bridge removed.';
  }
} else if (!settings.statusLine || isHuddleStatus(settings.statusLine)) {
  settings.statusLine = { type: 'command', command: statusCommand };
  statusNote = 'Status line bridge installed: quota and cost show in the huddle header (it prints nothing in the terminal).';
} else {
  statusNote =
    'You already have a statusLine, so it was left alone. Quota and cost will not show in the huddle.\n' +
    'Nothing is chained automatically; see README ("Quota and cost").';
}

fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
console.log(
  uninstall
    ? `Agent Huddle hooks removed from ${settingsFile}`
    : `Agent Huddle hooks installed in ${settingsFile}\nNew Claude Code sessions will show up in the huddle.`
);
if (statusNote) console.log(statusNote);
