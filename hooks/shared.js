// Shared by hooks/hook.js, scripts/install-hooks.js and scripts/setup.js.
// Node built-ins only: hook.js loads this on every event.

const fs = require('fs');
const os = require('os');
const path = require('path');

const settingsFile = () =>
  process.env.HUDDLE_SETTINGS_FILE || path.join(os.homedir(), '.claude', 'settings.json');

// Which hooks Huddle registers, and how. One definition for install-hooks
// (settings.json) and for the plugin (hooks/hooks.json).
//   command: the program to run (node)
//   hookPath: path to hook.js as the hook should see it
//   extra: arguments added after the mode (the plugin adds --plugin)
function huddleHooks(command, hookPath, extra = []) {
  const notify = { type: 'command', command, args: [hookPath, ...extra], async: true };
  const quick = { type: 'command', command, args: [hookPath, ...extra], timeout: 5 };
  const wait = { type: 'command', command, args: [hookPath, 'wait', ...extra], timeout: 3600 };
  return {
    SessionStart: [{ hooks: [quick] }],
    SessionEnd: [{ hooks: [quick] }],
    UserPromptSubmit: [{ hooks: [notify] }],
    // Questions (AskUserQuestion) are held on PermissionRequest, not PreToolUse:
    // a held PreToolUse keeps the editor from showing the question at all.
    PreToolUse: [{ matcher: '*', hooks: [notify] }],
    PostToolUse: [{ matcher: '*', hooks: [notify] }],
    PostToolUseFailure: [{ matcher: '*', hooks: [notify] }],
    PermissionRequest: [{ matcher: '*', hooks: [wait] }],
    Notification: [{ hooks: [notify] }],
    Stop: [{ hooks: [notify] }],
    SubagentStart: [{ hooks: [notify] }],
    SubagentStop: [{ hooks: [notify] }],
  };
}

// Is this path Huddle's hook.js? By folder name for installs made before the
// check below existed, otherwise by the package.json next to it, so a clone in
// any folder (agent-huddle-main from a GitHub zip, a plugin cache folder) counts.
function isHuddleHookPath(p) {
  const s = String(p || '');
  if (/agent-huddle[\\/]hooks[\\/]hook\.js$/i.test(s)) return true;
  if (!/[\\/]hooks[\\/]hook\.js$/i.test(s)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(s), '..', 'package.json'), 'utf8'));
    return pkg.name === 'agent-huddle';
  } catch {
    return false;
  }
}

const isHuddleHook = (h) => !!h && Array.isArray(h.args) && h.args.some(isHuddleHookPath);

// Huddle's status line bridge, as install-hooks writes it.
function isHuddleStatus(sl) {
  if (!sl || typeof sl.command !== 'string') return false;
  const m = /"([^"]*[\\/]hooks[\\/]hook\.js)"\s+status\b/i.exec(sl.command);
  return !!m && isHuddleHookPath(m[1]);
}

// Settings that already hold Huddle hooks from install-hooks (not the plugin's).
function settingsHaveHuddleHooks(settings) {
  const hooks = settings && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) for (const h of g?.hooks || []) if (isHuddleHook(h) && !h.args.includes('--plugin')) return true;
  }
  return false;
}

module.exports = { settingsFile, huddleHooks, isHuddleHookPath, isHuddleHook, isHuddleStatus, settingsHaveHuddleHooks };
