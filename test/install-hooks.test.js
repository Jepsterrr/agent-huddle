const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'install-hooks.js');

// A settings file in a folder with a space in its name, like a real Windows profile.
function setup(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle settings '));
  const file = path.join(dir, 'settings.json');
  if (initial) fs.writeFileSync(file, JSON.stringify(initial, null, 2));
  const run = (...args) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HUDDLE_SETTINGS_FILE: file } });
    assert.equal(r.status, 0, String(r.stderr));
    return { settings: JSON.parse(fs.readFileSync(file, 'utf8')), out: String(r.stdout) };
  };
  return { file, run };
}

test('install: exec-form hooks, questions on PermissionRequest, status line bridge added', () => {
  const { file, run } = setup({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.exe' }] }] } });
  const { settings } = run();
  assert.equal(settings.model, 'opus');
  for (const groups of Object.values(settings.hooks)) {
    for (const h of groups.flatMap((g) => g.hooks)) {
      if (h.command === 'mine.exe') continue;
      assert.equal(h.command, process.execPath);
      assert.ok(Array.isArray(h.args) && h.args[0].endsWith(path.join('hooks', 'hook.js')));
    }
  }
  // Questions are no longer held on PreToolUse.
  assert.ok(!settings.hooks.PreToolUse.some((g) => g.matcher === 'AskUserQuestion'));
  assert.ok(settings.hooks.PermissionRequest.some((g) => g.hooks.some((h) => h.args.includes('wait'))));
  // The user's own hook is kept.
  assert.ok(settings.hooks.Stop.some((g) => g.hooks.some((h) => h.command === 'mine.exe')));
  // Status line: a shell string, forward slashes, quoted path, status mode.
  assert.equal(settings.statusLine.type, 'command');
  assert.match(settings.statusLine.command, /"[^"]*\/hooks\/hook\.js" status$/);
  assert.ok(!settings.statusLine.command.includes('\\'));
  assert.ok(fs.existsSync(`${file}.huddle-backup`));

  // Re-running does not duplicate anything.
  const again = run().settings;
  assert.deepEqual(again, settings);

  // Uninstall removes our hooks and our status line, and keeps the rest.
  const gone = run('--uninstall').settings;
  assert.equal(gone.statusLine, undefined);
  assert.deepEqual(gone.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'mine.exe' }] }] });
});

test('an existing status line that is not ours is never touched', () => {
  const mine = { type: 'command', command: 'bash ~/.claude/my-statusline.sh', padding: 1 };
  const { run } = setup({ statusLine: mine });
  const { settings, out } = run();
  assert.deepEqual(settings.statusLine, mine);
  assert.match(out, /already have a statusLine/);
  assert.deepEqual(run('--uninstall').settings.statusLine, mine);
});

test('--no-statusline leaves the status line out', () => {
  const { run } = setup(null);
  assert.equal(run('--no-statusline').settings.statusLine, undefined);
  assert.ok(run().settings.statusLine);
  assert.equal(run('--no-statusline').settings.statusLine, undefined); // and removes ours
});
