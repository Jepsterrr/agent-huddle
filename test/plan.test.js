const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');

const A = { session_id: 'a', cwd: 'C:\\work\\shop' };
const B = { session_id: 'b', cwd: 'C:\\work\\shop' };
const h = (store, s, name, extra = {}, mode) => store.handle({ ...s, hook_event_name: name, ...extra }, mode);
const write = (file, extra = {}) => ({ tool_name: 'Write', tool_use_id: `w-${file}`, tool_input: { file_path: file, content: '# Plan' }, ...extra });

test('a plan is noticed when the main agent writes one, or leaves plan mode', () => {
  const store = new Store();
  h(store, A, 'UserPromptSubmit', { prompt: 'plan it' });
  h(store, A, 'PostToolUse', write('C:\\work\\shop\\README.md'));
  assert.equal(store.snapshot()[0].plan, null);
  // A subagent's draft does not count.
  h(store, A, 'PostToolUse', write('C:\\work\\shop\\docs\\superpowers\\plans\\draft.md', { agent_id: 'sub' }));
  assert.equal(store.snapshot()[0].plan, null);
  h(store, A, 'PostToolUse', write('C:\\work\\shop\\docs\\superpowers\\plans\\2026-11-18-retry-logic.md'));
  assert.deepEqual(
    (({ path, title }) => ({ path, title }))(store.snapshot()[0].plan),
    { path: 'C:\\work\\shop\\docs\\superpowers\\plans\\2026-11-18-retry-logic.md', title: 'retry-logic' }
  );
  h(store, A, 'PostToolUse', write('C:\\work\\shop\\migration-plan.md'));
  assert.equal(store.snapshot()[0].plan.title, 'migration-plan');

  h(store, B, 'PreToolUse', { tool_name: 'ExitPlanMode', tool_use_id: 'x', tool_input: { plan: '# Add dark mode\n\n1. Toggle\n2. Theme' } });
  const pb = store.sessions.get('b').plan;
  assert.equal(pb.title, 'Add dark mode');
  assert.match(pb.text, /1\. Toggle/);
});

test('a plan goes to another session only through its module, end to end', async () => {
  const store = new Store();
  h(store, A, 'UserPromptSubmit', { prompt: 'plan it' });
  h(store, B, 'UserPromptSubmit', { prompt: 'waiting' });
  h(store, A, 'PostToolUse', write('C:\\work\\shop\\docs\\superpowers\\plans\\2026-11-18-retry-logic.md'));

  // B has no module polling yet: it cannot receive.
  assert.equal(store.canReceive(store.sessions.get('b')), false);
  assert.equal(store.sendPlan('a', 'b'), false);

  // B's module polls: nothing waiting, but now B can receive.
  assert.equal(h(store, B, 'Inbox', {}, 'wait'), null);
  assert.equal(store.canReceive(store.sessions.get('b')), true);
  assert.equal(store.sendPlan('a', 'a'), false); // not to itself
  assert.equal(store.sendPlan('a', 'b'), true);
  assert.equal(store.sessions.get('a').plan.sent.status, 'queued');

  // B's module collects it and gets the prompt to submit.
  const held = h(store, B, 'Inbox', {}, 'wait');
  const out = await held.promise;
  assert.match(out.huddle.submit, /implementation plan written in another session \(shop\)/);
  assert.match(out.huddle.submit, /2026-11-18-retry-logic\.md/);
  assert.equal(store.sessions.get('a').plan.sent.status, 'collected');
  assert.equal(h(store, B, 'Inbox', {}, 'wait'), null); // collected once only

  h(store, B, 'Delivered', { from_id: 'a', ok: true });
  assert.equal(store.sessions.get('a').plan.sent.status, 'delivered');
});

test('the inbox never creates or revives a card, and a quiet module stops counting', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const store = new Store();
  assert.equal(h(store, { session_id: 'ghost', cwd: 'C:\\x' }, 'Inbox', {}, 'wait'), null);
  assert.equal(store.snapshot().length, 0);
  h(store, B, 'UserPromptSubmit', { prompt: 'x' });
  h(store, B, 'Inbox', {}, 'wait');
  assert.equal(store.canReceive(store.sessions.get('b')), true);
  t.mock.timers.tick(20_000);
  assert.equal(store.canReceive(store.sessions.get('b')), false);
});
