const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const { StartWatch } = require('../src/started');
const { Store } = require('../src/store');

const bash = (pid) => ({ pid, name: 'bash.exe' });

test('a new shell that lasts means the held command started', () => {
  const w = new StartWatch();
  const hooks = [{ pid: 1, name: 'node.exe' }, bash(2)]; // our hook and an older background shell
  assert.equal(w.check('p', hooks, 0, 0), false); // baseline
  assert.equal(w.check('p', [...hooks, bash(3)], 0, 100), false); // just appeared
  assert.equal(w.check('p', [...hooks, bash(3)], 0, 1100), true); // still there 1 s later
});

test('short-lived shells (status line bridge, hooks) and the baseline do not count', () => {
  const w = new StartWatch();
  w.check('p', [bash(2)], 0, 0);
  w.check('p', [bash(2), bash(5)], 0, 100); // status line: comes…
  assert.equal(w.check('p', [bash(2)], 0, 1200), false); // …and goes
  assert.equal(w.check('p', [bash(2)], 0, 5000), false); // the old shell never counts
  assert.equal(w.check('p', [bash(2), { pid: 9, name: 'node.exe' }], 0, 9000), false); // not a shell
});

test('commands already running in parallel are counted out', () => {
  const w = new StartWatch();
  w.check('p', [], 1, 0);
  w.check('p', [bash(3)], 1, 100); // the parallel command's shell
  assert.equal(w.check('p', [bash(3)], 1, 2000), false);
  w.check('p', [bash(3), bash(4)], 1, 2100); // now ours starts too
  assert.equal(w.check('p', [bash(3), bash(4)], 1, 3200), true);
});

test('PowerShell tool: cmd.exe is the child Claude Code starts', () => {
  const w = new StartWatch();
  w.check('p', [], 0, 0);
  w.check('p', [{ pid: 7, name: 'cmd.exe' }], 0, 10);
  assert.equal(w.check('p', [{ pid: 7, name: 'cmd.exe' }], 0, 1000), true);
});

test('store: shell prompts are listed, counted and released as answered elsewhere', async () => {
  const store = new Store();
  const S = { session_id: 's', cwd: 'C:\\p' };
  // Two events with the same parent pid make the pid trusted.
  store.handle({ ...S, hook_event_name: 'UserPromptSubmit', prompt: 'x' }, 'notify', { ppid: 42 });
  const cmd = { command: 'npm run long' };
  store.handle({ ...S, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: cmd, tool_use_id: 't1' }, 'notify', { ppid: 42 });
  store.handle({ ...S, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't2' }, 'notify', { ppid: 42 });
  const held = store.handle({ ...S, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: cmd }, 'wait', { ppid: 42 });

  const [w] = store.shellWaits();
  assert.equal(w.pid, 42);
  assert.equal(store.otherRunningShells('s'), 1); // npm test runs; npm run long waits

  store.releaseStarted(w.id);
  assert.equal(await held.promise, null); // no decision: Claude Code's own answer stands
  assert.equal(store.snapshot()[0].state, 'working');
  assert.deepEqual(store.shellWaits(), []);

  // Edit prompts are not watched (they finish at once and PostToolUse releases them).
  const e = store.handle({ ...S, hook_event_name: 'PermissionRequest', tool_name: 'Edit', tool_input: { file_path: 'C:\\p\\a' } }, 'wait');
  assert.deepEqual(store.shellWaits(), []);
  e.cancel();
});

test('foreground.children lists real child processes', { skip: process.platform !== 'win32' }, async () => {
  const focus = require('../src/foreground');
  if (!focus.isAvailable()) return;
  const child = spawn('cmd.exe', ['/c', 'ping -n 3 127.0.0.1 > nul'], { stdio: 'ignore', windowsHide: true });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const kids = focus.children(process.pid);
    assert.ok(kids.some((k) => k.pid === child.pid && k.name === 'cmd.exe'), JSON.stringify(kids));
  } finally {
    child.kill();
  }
});
