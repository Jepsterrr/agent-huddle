const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const b = require('../src/builder');
const { Store } = require('../src/store');

test('finds the real claude executable, not the npm shim', () => {
  const env = { PATH: ['C:\\tools', 'C:\\Users\\me\\AppData\\Roaming\\npm'].join(path.delimiter), APPDATA: 'C:\\Users\\me\\AppData\\Roaming' };
  const npmExe = path.join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  assert.equal(b.findClaude(env, (p) => p === npmExe), npmExe);
  assert.equal(b.findClaude(env, () => false), null);
});

test('the builder does not inherit the launching session', () => {
  const env = b.builderEnv({ PATH: 'x', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_PID: '9', ELECTRON_RUN_AS_NODE: '1', CLAUDE_CONFIG_DIR: 'C:\\cfg' });
  assert.deepEqual(env, { PATH: 'x', CLAUDE_CONFIG_DIR: 'C:\\cfg' });
});

test('builder command, prompt and the lines read back from claude', () => {
  assert.deepEqual(b.builderArgs({ title: 'retry-logic', prompt: 'P', model: 'sonnet' }), [
    '--bg', '--name', 'build: retry-logic', '--permission-mode', 'default', '--model', 'sonnet', 'P',
  ]);
  assert.deepEqual(b.builderArgs({ title: 'x', prompt: 'P' }).slice(-1), ['P']);
  assert.match(b.builderPrompt('Here is a plan'), /git branch your work is on\. Do not merge it\./);
  assert.deepEqual(b.parseBackgrounded('backgrounded · ddd0cda3 · build: x\n  claude agents …'), { id: 'ddd0cda3' });
  assert.equal(b.parseBackgrounded('error: not logged in'), null);
  const agents = JSON.stringify([{ id: 'ddd0cda3', sessionId: 'sess-1', kind: 'background' }]);
  assert.equal(b.sessionIdOf(agents, 'ddd0cda3'), 'sess-1');
  assert.equal(b.sessionIdOf(JSON.stringify({ value: [{ id: 'a', sessionId: 's' }] }), 'a'), 's');
  assert.equal(b.sessionIdOf('nope', 'a'), null);
  assert.match(b.reportPrompt('retry-logic', 'Built it on branch worktree-x'), /Do not merge without asking me\./);
});

// ---- the store's side of a build ----

const P = { session_id: 'planner', cwd: 'C:\\work\\shop' };
const B = { session_id: 'builder', cwd: 'C:\\work\\shop\\.claude\\worktrees\\x' };
const h = (store, s, name, extra = {}, mode) => store.handle({ ...s, hook_event_name: name, ...extra }, mode);
const writePlan = (file) => ({ tool_name: 'Write', tool_use_id: `w${file}`, tool_input: { file_path: file, content: '#' } });

test('only plans in a plans folder (or plan mode) start a builder by themselves', () => {
  const store = new Store();
  const ready = [];
  store.on('plan-ready', (id) => ready.push(id));
  h(store, P, 'UserPromptSubmit', { prompt: 'plan' });
  h(store, P, 'PostToolUse', writePlan('C:\\work\\shop\\plan-fas-1.md'));
  h(store, P, 'Stop', { last_assistant_message: 'Plan written' });
  assert.deepEqual(ready, []); // "plan" in the name only: waits for a click
  h(store, P, 'PostToolUse', writePlan('C:\\work\\shop\\docs\\superpowers\\plans\\2026-11-18-retry-logic.md'));
  h(store, P, 'Stop', { last_assistant_message: 'Plan complete' });
  assert.deepEqual(ready, ['planner']);
});

test('no builder for a plan its own session carries out (plan mode, or work after the plan)', () => {
  const store = new Store();
  const ready = [];
  store.on('plan-ready', (id) => ready.push(id));

  // Plan mode: once approved, the same session carries the plan out.
  h(store, P, 'UserPromptSubmit', { prompt: 'plan it' });
  h(store, P, 'PreToolUse', { tool_name: 'ExitPlanMode', tool_use_id: 'x', tool_input: { plan: '# Dark mode\n1. Toggle' } });
  h(store, P, 'PostToolUse', { tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: 'C:\\work\\shop\\src\\theme.js', old_string: 'a', new_string: 'b' } });
  h(store, P, 'Stop', { last_assistant_message: 'Dark mode added.' });
  assert.deepEqual(ready, []);
  assert.equal(store.sessions.get('planner').plan.kind, 'mode'); // still offered by hand

  // A plans-folder plan, then the session itself starts on it in the same turn.
  h(store, P, 'UserPromptSubmit', { prompt: 'next' });
  h(store, P, 'PostToolUse', writePlan('C:\\work\\shop\\docs\\superpowers\\plans\\2026-11-18-cache.md'));
  h(store, P, 'PostToolUse', { tool_name: 'Agent', tool_use_id: 'a1', tool_input: { description: 'Implement task 1', subagent_type: 'general-purpose' } });
  h(store, P, 'Stop', { last_assistant_message: 'Task 1 done.' });
  assert.deepEqual(ready, []);
  assert.equal(store.sessions.get('planner').plan.underway, true);

  // Reading, searching and reviewing after the plan does not count as carrying it out.
  h(store, P, 'UserPromptSubmit', { prompt: 'another' });
  h(store, P, 'PostToolUse', writePlan('C:\\work\\shop\\docs\\superpowers\\plans\\2026-11-18-search.md'));
  h(store, P, 'PostToolUse', { tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'C:\\work\\shop\\src\\a.js' } });
  h(store, P, 'PostToolUse', { tool_name: 'Agent', tool_use_id: 'a2', tool_input: { description: 'Review the plan', subagent_type: 'general-purpose' } });
  h(store, P, 'Stop', { last_assistant_message: 'Plan complete. Which approach?' });
  assert.deepEqual(ready, ['planner']);
});

test('a build from start to report, the builder card named after the plan', async () => {
  const store = new Store();
  h(store, P, 'UserPromptSubmit', { prompt: 'plan' });
  h(store, P, 'PostToolUse', writePlan('C:\\work\\shop\\docs\\superpowers\\plans\\2026-11-18-retry-logic.md'));
  h(store, P, 'Inbox', {}, 'wait'); // the planner has the plugin module
  h(store, P, 'Stop', { last_assistant_message: 'Plan complete' });

  assert.equal(store.buildStarting('planner'), true);
  assert.equal(store.runningBuilds(), 1);
  store.buildLaunched('planner', { bgId: 'ddd0cda3' });
  assert.equal(store.noticeBuilding('planner', 'build: retry-logic'), true);
  const notice = await h(store, P, 'Inbox', {}, 'wait').promise;
  assert.match(notice.huddle.submit, /Do not carry it out here/);
  store.buildLaunched('planner', { sessionId: 'builder' });

  h(store, B, 'SessionStart');
  h(store, B, 'UserPromptSubmit', { prompt: 'Here is an implementation plan…' });
  assert.equal(store.sessions.get('builder').title, 'build: retry-logic');
  assert.equal(store.sessions.get('builder').builderOf, 'planner');

  h(store, B, 'Stop', { last_assistant_message: 'Built retry logic. 5/5 tests pass. Branch: worktree-retry' });
  const build = store.sessions.get('planner').plan.build;
  assert.equal(build.status, 'done');
  assert.equal(build.report, 'queued');
  assert.equal(store.runningBuilds(), 0);
  const report = await h(store, P, 'Inbox', {}, 'wait').promise;
  assert.match(report.huddle.submit, /background builder for the plan "retry-logic" has finished/);
  assert.match(report.huddle.submit, /Branch: worktree-retry/);
  h(store, P, 'Delivered', { from_id: 'builder', ok: true });
  assert.equal(build.report, 'delivered');
});

test('a report nobody collects (the planner exited) moves to the builder card', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const store = new Store();
  h(store, P, 'UserPromptSubmit', { prompt: 'plan' });
  h(store, P, 'PostToolUse', writePlan('C:\\work\\shop\\docs\\superpowers\\plans\\x.md'));
  h(store, P, 'Inbox', {}, 'wait');
  store.buildStarting('planner');
  store.buildLaunched('planner', { bgId: 'a1', sessionId: 'builder' });
  // Measured live: the background planner exited 13 s before its builder finished.
  t.mock.timers.tick(5_000);
  h(store, B, 'Stop', { last_assistant_message: 'Built. Branch feat/x.' });
  const build = store.sessions.get('planner').plan.build;
  assert.equal(build.report, 'queued');
  store.expireOutbox();
  assert.equal(build.report, 'queued'); // still asking recently: keep waiting
  t.mock.timers.tick(20_000);
  store.expireOutbox();
  assert.equal(build.report, 'unavailable');
  assert.equal(store.outbox.size, 0);
});

test('a plan sent to a session that went away fails instead of waiting forever', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const store = new Store();
  h(store, P, 'UserPromptSubmit', { prompt: 'plan' });
  h(store, P, 'PostToolUse', writePlan('C:\\work\\shop\\docs\\superpowers\\plans\\x.md'));
  h(store, B, 'UserPromptSubmit', { prompt: 'idle' });
  h(store, B, 'Inbox', {}, 'wait');
  assert.equal(store.sendPlan('planner', 'builder'), true);
  t.mock.timers.tick(20_000);
  store.expireOutbox();
  assert.equal(store.sessions.get('planner').plan.sent.status, 'failed');
});

test('a fast builder is tied to its plan by its first prompt, even if done before claude agents answers', () => {
  const store = new Store();
  h(store, P, 'UserPromptSubmit', { prompt: 'plan' });
  const planFile = 'C:\\work\\shop\\docs\\superpowers\\plans\\2026-11-18-quick.md';
  h(store, P, 'PostToolUse', writePlan(planFile));
  store.buildStarting('planner');
  store.buildLaunched('planner', { bgId: 'q1' }); // `--bg` answered; the session id is not known yet

  // The builder starts, and finishes, before `claude agents --json` is read.
  const prompt = b.builderPrompt(store.planPromptFor('planner'));
  assert.equal(b.isBuilderPrompt(prompt), true);
  h(store, B, 'UserPromptSubmit', { prompt });
  assert.equal(store.sessions.get('builder').title, 'build: quick'); // tied at once
  h(store, B, 'Stop', { last_assistant_message: 'Done. Branch feat/quick.' });
  assert.equal(store.sessions.get('planner').plan.build.status, 'done');
  // The late answer from `claude agents` changes nothing.
  store.buildLaunched('planner', { sessionId: 'builder' });
  assert.equal(store.sessions.get('planner').plan.build.status, 'done');

  // A plan sent with "Send to…" is not a builder prompt.
  assert.equal(b.isBuilderPrompt(store.planPromptFor('planner')), false);
});

test('linked late: a builder already done is counted as done; one already gone as stopped', () => {
  const store = new Store();
  h(store, P, 'UserPromptSubmit', { prompt: 'plan' });
  h(store, P, 'PostToolUse', writePlan('C:\\work\\shop\\plans\\a.md'));
  store.buildStarting('planner');
  h(store, B, 'UserPromptSubmit', { prompt: 'something unrelated' }); // not recognisable by its prompt
  h(store, B, 'Stop', { last_assistant_message: 'All done on branch feat/a.' });
  store.buildLaunched('planner', { bgId: 'x', sessionId: 'builder' });
  const build = store.sessions.get('planner').plan.build;
  assert.equal(build.status, 'done');
  assert.match(build.message, /feat\/a/);

  h(store, P, 'PostToolUse', writePlan('C:\\work\\shop\\plans\\b.md'));
  store.buildStarting('planner');
  h(store, { ...B, session_id: 'gone' }, 'UserPromptSubmit', { prompt: 'x' });
  h(store, { ...B, session_id: 'gone' }, 'SessionEnd');
  store.buildLaunched('planner', { bgId: 'y', sessionId: 'gone' });
  assert.equal(store.sessions.get('planner').plan.build.status, 'stopped');
});

test('links and deliveries of a session that ended are forgotten', () => {
  const store = new Store();
  h(store, P, 'UserPromptSubmit', { prompt: 'plan' });
  h(store, P, 'PostToolUse', writePlan('C:\\work\\shop\\plans\\a.md'));
  store.buildStarting('planner');
  store.buildLaunched('planner', { bgId: 'x', sessionId: 'builder' });
  store.outbox.set('planner', { text: 't', fromId: 'builder' });
  h(store, P, 'SessionEnd');
  assert.equal(store.builders.size, 0);
  assert.equal(store.outbox.size, 0);
});

test('the builder is asked for subagent-driven execution when it has it', () => {
  assert.match(b.builderPrompt('Plan'), /subagent-driven execution/);
});

test('a builder that ends early, and a planner without the module', () => {
  const store = new Store();
  h(store, P, 'UserPromptSubmit', { prompt: 'plan' });
  h(store, P, 'PostToolUse', writePlan('C:\\work\\shop\\plans\\x.md'));
  store.buildStarting('planner');
  store.buildLaunched('planner', { bgId: 'a1', sessionId: 'builder' });
  h(store, B, 'UserPromptSubmit', { prompt: 'go' });
  h(store, B, 'SessionEnd');
  assert.equal(store.sessions.get('planner').plan.build.status, 'stopped');

  // Again, finished this time, but the planner cannot receive: the report stays on the builder's card.
  store.buildStarting('planner');
  store.buildLaunched('planner', { bgId: 'a2', sessionId: 'builder2' });
  h(store, { ...B, session_id: 'builder2' }, 'Stop', { last_assistant_message: 'done' });
  const build = store.sessions.get('planner').plan.build;
  assert.deepEqual([build.status, build.report], ['done', 'unavailable']);
  assert.equal(store.outbox.size, 0);
});
