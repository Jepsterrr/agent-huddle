const test = require('node:test');
const assert = require('node:assert/strict');
const { family, shortModel, verdict, summary, label } = require('../src/team');
const { Store } = require('../src/store');

const S = { session_id: 's', cwd: 'C:\\p' };
const ev = (name, extra = {}) => ({ ...S, hook_event_name: name, ...extra });
const call = (id, description, extra = {}) => ({
  tool_name: 'Agent',
  tool_use_id: id,
  tool_input: { description, prompt: 'p', subagent_type: 'general-purpose', ...extra },
});

test('role families, so a step that comes round again is counted', () => {
  assert.equal(family('Spec review task 3', 'general-purpose'), 'spec-review');
  assert.equal(family('Check spec compliance', ''), 'spec-review');
  assert.equal(family('Code quality review', 'general-purpose'), 'review');
  assert.equal(family('', 'superpowers:code-reviewer'), 'review');
  assert.equal(family('Implement task 3: retry logic', 'general-purpose'), 'implement');
  assert.equal(family('Fix spec gaps in task 3', ''), 'implement');
  assert.equal(family('Find auth handlers', 'Explore'), 'explore');
  assert.equal(family('Plan the migration', 'Plan'), 'plan');
  assert.equal(family('Run the test suite', ''), 'test');
  assert.equal(family('Field check, no tools', 'general-purpose'), 'other');
});

test('model ids shorten to the family name', () => {
  assert.equal(shortModel('claude-sonnet-5-5'), 'sonnet');
  assert.equal(shortModel('claude-haiku-5-5-20261001'), 'haiku');
  assert.equal(shortModel('opus'), 'opus');
  assert.equal(shortModel('claude-fable-5-2'), 'fable');
  assert.equal(shortModel('gpt-x'), 'gpt-x');
  assert.equal(shortModel(undefined), '');
});

test('verdicts: superpowers statuses and plain reviewer answers', () => {
  assert.equal(verdict('Spec review: ✅ compliant'), 'pass');
  assert.equal(verdict('✅ Spec compliant - all requirements met, nothing extra'), 'pass');
  assert.equal(verdict('Code reviewer: Strengths: Solid. Issues: None. Approved.'), 'pass');
  assert.equal(verdict('❌ Issues:\n- Missing: progress reporting'), 'fail');
  assert.equal(verdict('Not spec compliant: 2 gaps'), 'fail');
  assert.equal(verdict('Found 3 issues in error handling'), 'fail');
  assert.equal(verdict('Status: DONE\nImplemented install-hook, 5/5 tests passing'), 'pass');
  assert.equal(verdict('Status: DONE_WITH_CONCERNS\nthis file is getting large'), 'warn');
  assert.equal(verdict('Status: BLOCKED - cannot reach the database'), 'fail');
  assert.equal(verdict('NEEDS_CONTEXT: which config file?'), 'fail');
  assert.equal(verdict('All 12 tests pass.'), 'pass');
  assert.equal(verdict('2 tests failed'), 'fail');
  assert.equal(verdict('Here is what I found in src/: three handlers.'), null); // no verdict: just a report
  assert.equal(verdict(''), null);
});

test('store: events in the order measured live make one entry, not two', () => {
  const store = new Store();
  store.handle(ev('UserPromptSubmit', { prompt: 'go' }));
  // Measured on 2.1.322: SubagentStart lands before the Agent call's PreToolUse.
  store.handle(ev('SubagentStart', { agent_id: 'a1', agent_type: 'general-purpose' }));
  store.handle(ev('PreToolUse', call('t1', 'Spec review task 1', { model: 'haiku' })));
  store.handle(ev('PostToolUse', { ...call('t1', 'Spec review task 1', { model: 'haiku' }), tool_response: { agentId: 'a1', resolvedModel: 'claude-haiku-5-5', status: 'async_launched' } }));
  store.handle(ev('SubagentStop', { agent_id: 'a1', agent_type: 'general-purpose', last_assistant_message: 'Spec review: ✅ compliant' }));
  const t = store.snapshot()[0].team;
  assert.equal(t.length, 1);
  assert.deepEqual(
    { label: t[0].label, model: t[0].model, status: t[0].status, verdict: t[0].verdict, family: t[0].family },
    { label: 'Spec review task 1', model: 'haiku', status: 'done', verdict: 'pass', family: 'spec-review' }
  );
});

test('store: a superpowers round trip counts rounds per task', () => {
  const store = new Store();
  store.handle(ev('UserPromptSubmit', { prompt: 'run the plan' }));
  store.handle(ev('PreToolUse', { tool_name: 'TodoWrite', tool_use_id: 'td', tool_input: { todos: [{ content: 'Task 3', activeForm: 'Doing task 3', status: 'in_progress' }, { content: 'Task 4', status: 'pending' }] } }));
  const run = (id, desc, model, msg) => {
    store.handle(ev('PreToolUse', call(id, desc, { model })));
    store.handle(ev('SubagentStart', { agent_id: `ag-${id}`, agent_type: 'general-purpose' }));
    store.handle(ev('SubagentStop', { agent_id: `ag-${id}`, agent_type: 'general-purpose', last_assistant_message: msg }));
    store.handle(ev('PostToolUse', { ...call(id, desc, { model }), tool_response: { agentId: `ag-${id}`, resolvedModel: model, status: 'completed' } }));
  };
  run('1', 'Implement task 3', 'sonnet', 'Status: DONE\n5/5 tests passing');
  run('2', 'Spec review task 3', 'opus', '❌ Issues:\n- Missing progress reporting');
  run('3', 'Fix spec gaps task 3', 'sonnet', 'Status: DONE');
  run('4', 'Spec review task 3', 'opus', '✅ Spec compliant');
  const t = store.snapshot()[0].team;
  assert.deepEqual(
    t.map((a) => [a.family, a.round, a.verdict, a.model]),
    [
      ['implement', 1, 'pass', 'sonnet'],
      ['spec-review', 1, 'fail', 'opus'],
      ['implement', 2, 'pass', 'sonnet'],
      ['spec-review', 2, 'pass', 'opus'],
    ]
  );
  assert.equal(t[0].summary, '5/5 tests passing');
  assert.equal(t[1].summary, 'Missing progress reporting');
});

test('store: a failed Agent call fails its entry; a new prompt starts a new team', () => {
  const store = new Store();
  store.handle(ev('UserPromptSubmit', { prompt: 'go' }));
  store.handle(ev('PreToolUse', call('t1', 'Explore the repo')));
  store.handle(ev('PostToolUseFailure', { ...call('t1', 'Explore the repo'), error: 'boom' }));
  let t = store.snapshot()[0].team;
  assert.equal(t.length, 1);
  assert.equal(t[0].status, 'failed');

  // A running subagent keeps the team across a new prompt; a finished team does not.
  store.handle(ev('PreToolUse', call('t2', 'Implement it')));
  store.handle(ev('UserPromptSubmit', { prompt: 'and also' }));
  assert.equal(store.snapshot()[0].team.length, 2);
  store.handle(ev('SubagentStop', { agent_id: 'x', agent_type: 'general-purpose', last_assistant_message: 'DONE' }));
  store.handle(ev('UserPromptSubmit', { prompt: 'next thing' }));
  assert.equal(store.snapshot()[0].team.length, 0);
});

test('summary is the first readable line, label falls back to the type', () => {
  assert.equal(summary('## Result\n\n**Spec review:** ✅ compliant'), 'Spec review: compliant');
  assert.equal(summary('Status: DONE\n\nAdded retry with backoff.'), 'Added retry with backoff.');
  assert.equal(summary('Status: DONE - added the flag'), 'added the flag');
  assert.equal(summary('Status: DONE'), 'Status: DONE'); // nothing better to show
  assert.equal(summary('\n\n- `Issues:` none'), 'Issues: none');
  assert.equal(summary('x'.repeat(300)).length, 100);
  assert.equal(label('Implement task 3', 'general-purpose'), 'Implement task 3');
  assert.equal(label('', 'superpowers:code-reviewer'), 'code-reviewer');
  assert.equal(label('', ''), 'subagent');
});
