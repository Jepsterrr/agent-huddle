// The plugin module's behaviour, run for real: its decisions (mod-logic.mjs)
// in any Node, and its register() with a stand-in `$` where Node can load
// TypeScript (22.18 and later strip the types by themselves).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const HOOKS = path.resolve(__dirname, '..', 'hooks');
const logic = () => import(pathToFileURL(path.join(HOOKS, 'mod-logic.mjs')).href);

const ROUTING = {
  enabled: true,
  families: [
    { name: 'explore', pattern: '\\bexplore\\b|\\bfind\\b', model: 'haiku' },
    { name: 'review', pattern: 'review', model: 'opus' },
    { name: 'implement', pattern: 'implement', model: null }, // "agent decides"
    { name: 'odd', pattern: 'weird', model: 'gpt-9' },
  ],
};

test('chooseModel: fills in a missing model for built-in subagents only', async () => {
  const { chooseModel } = await logic();
  assert.deepEqual(chooseModel(ROUTING, { description: 'Find auth handlers', subagent_type: 'Explore' }), { family: 'explore', model: 'haiku' });
  assert.deepEqual(chooseModel(ROUTING, { description: 'Spec review task 3', subagent_type: 'general-purpose' }), { family: 'review', model: 'opus' });
  assert.deepEqual(chooseModel(ROUTING, { description: 'Review it' }), { family: 'review', model: 'opus' }); // no type: general-purpose
  // The agent's own choice always wins.
  assert.equal(chooseModel(ROUTING, { description: 'Review it', model: 'sonnet' }), null);
  // A custom or plugin agent keeps its definition's model.
  assert.equal(chooseModel(ROUTING, { description: 'Review it', subagent_type: 'superpowers:code-reviewer' }), null);
  // A row left at "agent decides", or a model Claude Code does not have, changes nothing.
  assert.equal(chooseModel(ROUTING, { description: 'Implement task 2' }), null);
  assert.equal(chooseModel(ROUTING, { description: 'weird task' }), null);
  // No rules, or no rule that matches.
  assert.equal(chooseModel(null, { description: 'Review it' }), null);
  assert.equal(chooseModel(ROUTING, { description: 'Write the docs' }), null);
  // A broken pattern is skipped, not thrown.
  const broken = { enabled: true, families: [{ name: 'bad', pattern: '(', model: 'opus' }, ROUTING.families[1]] };
  assert.deepEqual(chooseModel(broken, { description: 'review' }), { family: 'review', model: 'opus' });
});

test('parseRouting and parseRuntime refuse what they cannot use', async () => {
  const { parseRouting, parseRuntime } = await logic();
  assert.deepEqual(parseRouting(JSON.stringify(ROUTING)), ROUTING);
  assert.equal(parseRouting(JSON.stringify({ ...ROUTING, enabled: false })), null);
  assert.equal(parseRouting(JSON.stringify({ enabled: true })), null);
  assert.equal(parseRouting('{nope'), null);
  assert.deepEqual(parseRuntime('{"port":4321,"token":"t","pid":7}'), { port: 4321, token: 't', pid: 7 });
  for (const bad of ['{}', '{"port":"4321","token":"t"}', '{"port":0,"token":"t"}', '{"port":4321,"token":""}', 'x']) {
    assert.equal(parseRuntime(bad), null, bad);
  }
});

test('statusEvent sends the same fields as hook.js status; inboxMessage reads only a real plan', async () => {
  const { statusEvent, inboxMessage } = await logic();
  const e = {
    rateLimits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: '2026-11-18T12:00:00Z' }, { kind: 'seven_day', percentUsed: 10 }],
    cost: { usd: 1.25 },
    context: { percent: 30 },
  };
  assert.deepEqual(statusEvent(e), {
    hook_event_name: 'StatusLine',
    source: 'mod',
    cost_usd: 1.25,
    context_pct: 30,
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: Date.parse('2026-11-18T12:00:00Z') / 1000 },
      seven_day: { used_percentage: 10, resets_at: undefined },
    },
  });
  assert.equal(statusEvent({ rateLimits: [], context: {} }).rate_limits, undefined);

  assert.deepEqual(inboxMessage(200, '{"huddle":{"submit":"Here is a plan","fromId":"p1"}}'), { submit: 'Here is a plan', fromId: 'p1' });
  assert.equal(inboxMessage(204, ''), null);
  assert.equal(inboxMessage(200, '{"huddle":{}}'), null);
  assert.equal(inboxMessage(200, '{"huddle":{"submit":42}}'), null);
  assert.equal(inboxMessage(200, 'not json'), null);
});

// ---- register() itself, with a stand-in for Claude Code's `$` ----

const canLoadTs = !!process.features?.typescript;

function fakeEngine({ files = {}, replies = [] } = {}) {
  const sent = [];
  const submitted = [];
  const timers = [];
  const $ = {
    env: { get: async (k) => (k === 'HUDDLE_HOME' ? 'H' : undefined) },
    fs: {
      read: async (p) => {
        if (p in files) return files[p];
        throw new Error('ENOENT');
      },
    },
    session: { id: async () => 'sess-1' },
    http: {
      fetch: async (url, init) => {
        sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        return replies.shift() || { status: 204, text: '' };
      },
    },
    prompt: { submit: async (p) => submitted.push(p.text) },
    clock: {
      every: (ms, fn) => {
        const t = { ms, fn, cancelled: false, cancel: () => (t.cancelled = true) };
        timers.push(t);
        return t;
      },
    },
  };
  return { $, sent, submitted, timers };
}

async function loadMod() {
  const mod = await import(pathToFileURL(path.join(HOOKS, 'huddle-mod.ts')).href + `?t=${Math.random()}`);
  const hooks = {};
  const on = (event, matcher, hook) => {
    const h = { fn: hook || matcher, catcher: null };
    hooks[event] = h;
    return { catch: (c) => (h.catcher = c) };
  };
  mod.register(on);
  // Runs a hook as the engine would, its .catch answering when it throws.
  const run = async (event, $, e, next = async (x) => x) => {
    const h = hooks[event];
    try {
      return await h.fn($, e, next);
    } catch (err) {
      if (h.catcher) return h.catcher($, e, next);
      throw err;
    }
  };
  return { hooks, run };
}

const RUNTIME = { 'H/runtime.json': JSON.stringify({ port: 4321, token: 'tok', pid: 1 }) };

test('register: an Agent call gets the rule\'s model, and the huddle is told', { skip: !canLoadTs && 'Node cannot load TypeScript here' }, async () => {
  const { run } = await loadMod();
  const eng = fakeEngine({ files: { ...RUNTIME, 'H/routing.json': JSON.stringify(ROUTING) } });
  const e = { tool: 'Agent', tool_use_id: 'tu1', description: 'Find auth handlers', subagent_type: 'Explore' };
  const out = await run('tool.call', eng.$, e);
  assert.equal(out.model, 'haiku');
  await new Promise((r) => setImmediate(r)); // the notice is sent without waiting
  assert.deepEqual(eng.sent.map((s) => s.body), [{ session_id: 'sess-1', hook_event_name: 'Routed', tool_use_id: 'tu1', family: 'explore', model: 'haiku' }]);
  assert.equal(eng.sent[0].url, 'http://127.0.0.1:4321/event');
  assert.equal(eng.sent[0].headers['x-huddle-token'], 'tok');

  // The agent's own model, a custom agent, no rules file: passed on untouched.
  for (const [input, files] of [
    [{ ...e, model: 'sonnet' }, { 'H/routing.json': JSON.stringify(ROUTING) }],
    [{ ...e, subagent_type: 'my-agent' }, { 'H/routing.json': JSON.stringify(ROUTING) }],
    [e, {}],
    [e, { 'H/routing.json': '{broken' }],
  ]) {
    const quiet = fakeEngine({ files });
    assert.deepEqual(await run('tool.call', quiet.$, input), input);
    assert.equal(quiet.sent.length, 0);
  }
});

test('register: quota figures go to the app, and a missing app changes nothing', { skip: !canLoadTs && 'Node cannot load TypeScript here' }, async () => {
  const { run } = await loadMod();
  const e = { rateLimits: [{ kind: 'five_hour', percentUsed: 5 }], context: { percent: 1 } };
  const eng = fakeEngine({ files: RUNTIME });
  assert.equal(await run('session.measure', eng.$, e, async () => 'result'), 'result');
  assert.equal(eng.sent[0].body.hook_event_name, 'StatusLine');
  assert.equal(eng.sent[0].headers['x-huddle-mode'], 'notify');
  const none = fakeEngine();
  assert.equal(await run('session.measure', none.$, e, async () => 'result'), 'result');
});

test('register: one inbox timer, a plan is submitted once and reported back', { skip: !canLoadTs && 'Node cannot load TypeScript here' }, async () => {
  const { run } = await loadMod();
  const eng = fakeEngine({
    files: RUNTIME,
    replies: [{ status: 200, text: JSON.stringify({ huddle: { submit: 'Here is a plan', fromId: 'p1' } }) }],
  });
  await run('session.start', eng.$, {});
  await run('session.start', eng.$, {}); // a second start replaces the timer, never adds one
  assert.equal(eng.timers.length, 2);
  assert.equal(eng.timers[0].cancelled, true);
  const live = eng.timers[1];
  assert.equal(live.ms, 3000);

  live.fn();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(eng.submitted, ['Here is a plan']);
  assert.deepEqual(eng.sent.map((s) => [s.headers['x-huddle-mode'], s.body.hook_event_name]), [['wait', 'Inbox'], ['notify', 'Delivered']]);
  assert.deepEqual(eng.sent[1].body, { session_id: 'sess-1', hook_event_name: 'Delivered', from_id: 'p1', ok: true });

  live.fn(); // nothing waiting now
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(eng.submitted, ['Here is a plan']);

  // A /clear keeps polling (no new session.start follows); a real end stops it.
  await run('session.end', eng.$, { reason: 'clear' });
  assert.equal(live.cancelled, false);
  await run('session.end', eng.$, { reason: 'prompt_input_exit' });
  assert.equal(live.cancelled, true);
});
