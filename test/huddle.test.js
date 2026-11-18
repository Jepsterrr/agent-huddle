const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { Store } = require('../src/store');
const { startServer } = require('../src/server');

const HOOK = path.resolve(__dirname, '..', 'hooks', 'hook.js');
const S = { session_id: 's1', cwd: 'C:\\work\\my-app' };
const ev = (name, extra = {}) => ({ ...S, hook_event_name: name, ...extra });

test('a session becomes a buddy and tracks tool steps', () => {
  const store = new Store();
  store.handle(ev('SessionStart'));
  store.handle(ev('UserPromptSubmit', { prompt: 'fix it' }));
  store.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' }));

  const [s] = store.snapshot();
  assert.equal(s.name, 'my-app');
  assert.equal(s.state, 'working');
  assert.equal(s.steps.at(-1).status, 'running');

  store.handle(ev('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1', duration_ms: 12 }));
  assert.equal(s.steps.at(-1).status, 'done');
  assert.equal(s.steps.length, 2);

  store.handle(ev('Stop', { last_assistant_message: 'all good' }));
  assert.equal(s.state, 'done');

  store.handle(ev('SessionEnd'));
  assert.equal(store.snapshot().length, 0);
});

test('PostToolUse arriving before its PreToolUse does not duplicate the step', () => {
  const store = new Store();
  const t = { tool_name: 'Read', tool_input: { file_path: 'a.txt' }, tool_use_id: 't9' };
  store.handle(ev('PostToolUse', t));
  store.handle(ev('PreToolUse', t));
  const [s] = store.snapshot();
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].status, 'done');
});

test('permission: allow, deny and passthrough produce the right hook output', async () => {
  const store = new Store();
  const req = () =>
    store.handle(ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm x' } }), 'wait');
  const pendingId = () => store.snapshot()[0].pending[0].id;

  let held = req();
  assert.equal(store.snapshot()[0].state, 'permission');
  store.answer(pendingId(), { type: 'allow' });
  assert.deepEqual(await held.promise, {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  assert.equal(store.snapshot()[0].state, 'working');

  held = req();
  store.answer(pendingId(), { type: 'deny' });
  assert.equal((await held.promise).hookSpecificOutput.decision.behavior, 'deny');

  held = req();
  store.answer(pendingId(), { type: 'passthrough' });
  assert.equal(await held.promise, null);
  assert.equal(store.snapshot()[0].state, 'attention');
});

test('risk and diff are shown on the card but never change the hook decision', async () => {
  const store = new Store({ home: 'C:\\Users\\Me', readFile: () => 'a\nb\n' });
  const held = store.handle(ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf C:\\' } }), 'wait');
  const p = store.snapshot()[0].pending[0];
  assert.equal(p.risk.level, 'high');
  assert.ok(p.risk.reasons.includes('deletes recursively'));
  assert.equal(p.diff, null);
  // High risk does not deny on its own: nothing is answered until the user clicks.
  let settled = false;
  held.promise.then(() => (settled = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  store.answer(p.id, { type: 'allow' });
  assert.deepEqual(await held.promise, {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });

  const w = store.handle(
    ev('PermissionRequest', { tool_name: 'Write', tool_input: { file_path: 'C:\\work\\my-app\\x.txt', content: 'a\nB\n' } }),
    'wait'
  );
  const q = store.snapshot()[0].pending[0];
  assert.equal(q.risk.level, 'low');
  assert.deepEqual(q.diff.lines.map((l) => l.t + l.s), [' a', '-b', '+B', ' ']);
  assert.equal(q.detail, 'C:\\work\\my-app\\x.txt');
  w.cancel();
});

test('"always allow" passes on exactly the rules Claude Code suggested', async () => {
  const store = new Store();
  const suggestions = [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm install:*' }], behavior: 'allow', destination: 'localSettings' },
  ];
  const held = store.handle(
    ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm install x' }, permission_suggestions: suggestions }),
    'wait'
  );
  const p = store.snapshot()[0].pending[0];
  assert.equal(p.always, 'Allow Bash(npm install:*) in this project');
  store.answer(p.id, { type: 'always' });
  assert.deepEqual((await held.promise).hookSpecificOutput.decision, { behavior: 'allow', updatedPermissions: suggestions });

  // No suggestion, or one we cannot describe: the option is not offered and cannot be forced.
  for (const permission_suggestions of [undefined, [{ type: 'somethingNew' }]]) {
    const h = store.handle(ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'x' }, permission_suggestions }), 'wait');
    const q = store.snapshot()[0].pending[0];
    assert.equal(q.always, '');
    assert.equal(store.answer(q.id, { type: 'always' }), false);
    h.cancel();
  }
});

test('a question is held on PermissionRequest and answered with an answers map', async () => {
  const store = new Store();
  const questions = [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }];
  const held = store.handle(ev('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions } }), 'wait');
  const [s] = store.snapshot();
  assert.equal(s.state, 'question');
  store.answer(s.pending[0].id, { type: 'answers', answers: { 'Which?': 'B' } });
  assert.deepEqual(await held.promise, {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: { questions, answers: { 'Which?': 'B' } } },
    },
  });
});

test('PreToolUse is never held, so the editor can show the question too', () => {
  const store = new Store();
  const questions = [{ question: 'Which?', options: [{ label: 'A' }] }];
  // An older install still sends this in wait mode; it must return at once.
  assert.equal(store.handle(ev('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions } }), 'wait'), null);
  assert.equal(store.snapshot()[0].pending.length, 0);
});

test('a question answered in the editor is released when the tool runs', async () => {
  const store = new Store();
  const questions = [{ question: 'Which?', options: [{ label: 'A' }] }];
  const held = store.handle(ev('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions } }), 'wait');
  // The tool's input now carries the answers, so it does not match exactly.
  store.handle(ev('PostToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions, answers: { 'Which?': 'A' } }, tool_use_id: 'q1' }));
  assert.equal(await held.promise, null);
  assert.equal(store.snapshot()[0].state, 'working');
});

test('a hook that goes away, or a Stop, releases the pending request', async () => {
  const store = new Store();
  const a = store.handle(ev('PermissionRequest', { tool_name: 'Bash', tool_input: {} }), 'wait');
  a.cancel();
  assert.equal(await a.promise, null);
  assert.equal(store.snapshot()[0].pending.length, 0);

  const b = store.handle(ev('PermissionRequest', { tool_name: 'Bash', tool_input: {} }), 'wait');
  store.handle(ev('Stop'));
  assert.equal(await b.promise, null);
  assert.equal(store.snapshot()[0].state, 'done');
});

test('a prompt answered in VS Code is released when the tool goes ahead', async () => {
  const store = new Store();
  const t = { tool_name: 'Bash', tool_input: { command: 'npm i' }, tool_use_id: 'p1' };
  store.handle(ev('PreToolUse', t));
  const held = store.handle(ev('PermissionRequest', { tool_name: t.tool_name, tool_input: t.tool_input }), 'wait');
  // The async PreToolUse for the same call can arrive late; it must not release it.
  store.handle(ev('PreToolUse', t));
  const [s] = store.snapshot();
  assert.equal(s.state, 'permission');

  store.handle(ev('PostToolUse', t)); // allowed in VS Code, tool ran
  assert.equal(await held.promise, null);
  assert.equal(s.pending.length, 0);
  assert.equal(s.state, 'working');
});

test('a prompt denied in VS Code is released when the agent moves on', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const store = new Store();
  const held = store.handle(ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm x' } }), 'wait');
  const other = { tool_name: 'Read', tool_input: { file_path: 'a' }, tool_use_id: 'n1' };

  store.handle(ev('PreToolUse', other)); // same instant: a parallel call, keep holding
  assert.equal(store.snapshot()[0].state, 'permission');

  t.mock.timers.tick(5000);
  store.handle(ev('PreToolUse', { ...other, tool_use_id: 'n2' }));
  assert.equal(await held.promise, null);
  assert.equal(store.snapshot()[0].state, 'working');
});

test('an ended session is not brought back by an event that lands late', () => {
  const store = new Store();
  store.handle(ev('UserPromptSubmit', { prompt: 'hi' }));
  store.handle(ev('SessionEnd'));
  store.handle(ev('Stop', { last_assistant_message: 'bye' }));
  store.handle(ev('PostToolUse', { tool_name: 'Read', tool_input: {}, tool_use_id: 'late' }));
  assert.equal(store.snapshot().length, 0);
});

test('a session whose Claude Code process died is removed', () => {
  const store = new Store();
  store.handle(ev('UserPromptSubmit', { prompt: 'hi' }), 'notify', { ppid: 111 });
  store.reap(() => false); // one sighting is not enough to trust the pid
  assert.equal(store.snapshot().length, 1);

  store.handle(ev('PreToolUse', { tool_name: 'Read', tool_input: {}, tool_use_id: 'a' }), 'notify', { ppid: 111 });
  store.reap(() => true);
  assert.equal(store.snapshot().length, 1);
  store.reap(() => false);
  assert.equal(store.snapshot().length, 0);

  // Pids that disagree are never trusted.
  const other = { session_id: 's2', cwd: 'C:\\x', hook_event_name: 'UserPromptSubmit', prompt: 'hi' };
  store.handle(other, 'notify', { ppid: 1 });
  store.handle(other, 'notify', { ppid: 2 });
  store.handle(other, 'notify', { ppid: 2 });
  store.reap(() => false);
  assert.equal(store.snapshot().length, 1);
});

test('a background-task notice is not shown as the user\'s prompt', () => {
  const store = new Store();
  const prompt =
    '<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n' +
    '<summary>Agent "Run one test command" finished</summary>\n<result>ok</result>\n</task-notification>';
  store.handle(ev('UserPromptSubmit', { prompt }));
  const step = store.snapshot()[0].steps.at(-1);
  assert.equal(step.kind, 'agent');
  assert.equal(step.title, 'Background task: Agent "Run one test command" finished');
  assert.equal(store.snapshot()[0].state, 'working');

  store.handle(ev('UserPromptSubmit', { prompt: 'what is <task-notification>?' }));
  assert.equal(store.snapshot()[0].steps.at(-1).kind, 'prompt'); // a real prompt that mentions it
});

test('dismissed buddies stay away until the user prompts again', () => {
  const store = new Store();
  store.handle(ev('SessionStart'));
  store.dismiss('s1');
  store.handle(ev('PostToolUse', { tool_name: 'Read', tool_input: {}, tool_use_id: 'x' }));
  assert.equal(store.snapshot().length, 0);
  store.handle(ev('UserPromptSubmit', { prompt: 'again' }));
  assert.equal(store.snapshot().length, 1);
});

// ---- the real hook script against the real server ----

function runHook(home, payload, wait) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, wait ? [HOOK, 'wait'] : [HOOK], {
      env: { ...process.env, HUDDLE_HOME: home, HUDDLE_NO_AUTOSTART: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('hook script: silent and exit 0 when the app is not running', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-'));
  assert.deepEqual(await runHook(home, ev('PermissionRequest'), true), { code: 0, out: '' });

  // Stale runtime file pointing at a dead port.
  fs.writeFileSync(path.join(home, 'runtime.json'), JSON.stringify({ port: 9, token: 'x' }));
  assert.deepEqual(await runHook(home, ev('PermissionRequest'), true), { code: 0, out: '' });
});

test('hook script: a runtime file whose app is gone gets nothing, even if its port answers', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-'));
  let seen = 0;
  const server = await startServer({ token: 'secret', onEvent: () => (seen++, null) });
  // The pid of a process that has just exited stands for an app that crashed.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  try {
    fs.writeFileSync(path.join(home, 'runtime.json'), JSON.stringify({ port: server.address().port, token: 'secret', pid: dead }));
    assert.deepEqual(await runHook(home, ev('PermissionRequest'), true), { code: 0, out: '' });
    assert.equal(seen, 0);
    // The same file with a live pid is used.
    fs.writeFileSync(path.join(home, 'runtime.json'), JSON.stringify({ port: server.address().port, token: 'secret', pid: process.pid }));
    await runHook(home, ev('UserPromptSubmit', { prompt: 'hi' }));
    assert.equal(seen, 1);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('hook script: end to end through the server', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-'));
  const store = new Store();
  const server = await startServer({ token: 'secret', onEvent: (p, mode) => store.handle(p, mode) });
  fs.writeFileSync(path.join(home, 'runtime.json'), JSON.stringify({ port: server.address().port, token: 'secret' }));

  try {
    assert.deepEqual(await runHook(home, ev('UserPromptSubmit', { prompt: 'hi' })), { code: 0, out: '' });
    assert.equal(store.snapshot()[0].state, 'working');

    const waiting = runHook(home, ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }), true);
    await new Promise((r) => store.once('change', r));
    store.answer(store.snapshot()[0].pending[0].id, { type: 'allow' });
    const { code, out } = await waiting;
    assert.equal(code, 0);
    assert.equal(JSON.parse(out).hookSpecificOutput.decision.behavior, 'allow');

    // Wrong token: ignored, and the hook still exits cleanly.
    fs.writeFileSync(path.join(home, 'runtime.json'), JSON.stringify({ port: server.address().port, token: 'nope' }));
    store.handle(ev('SessionEnd'));
    assert.deepEqual(await runHook(home, ev('SessionStart')), { code: 0, out: '' });
    assert.equal(store.snapshot().length, 0);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
