const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RULE_ROWS, MODELS, cleanRouting, nextModel, routingFile } = require('../src/routing');
const { family } = require('../src/team');
const { Store } = require('../src/store');

test('rules are off by default and stored values are cleaned', () => {
  assert.deepEqual(cleanRouting(undefined), { enabled: false, explore: '', plan: '', implement: '', test: '', review: '' });
  assert.deepEqual(cleanRouting({ enabled: 'yes', explore: 'haiku', review: 'gpt-9', extra: 1 }), {
    enabled: false, explore: 'haiku', plan: '', implement: '', test: '', review: '',
  });
  assert.equal(routingFile(undefined).enabled, false);
});

test('a row steps through the models and back to "agent decides"', () => {
  let m = '';
  const seen = [];
  for (let i = 0; i < MODELS.length; i++) seen.push((m = nextModel(m)));
  assert.deepEqual(seen, ['haiku', 'sonnet', 'opus', 'fable', '']);
  // Only models Claude Code's Agent tool accepts (2.1.322).
  for (const x of MODELS.filter(Boolean)) assert.ok(['sonnet', 'opus', 'haiku', 'fable'].includes(x));
});

test('routing.json picks the same role as the team view, and only the rows you set', () => {
  const file = routingFile({ enabled: true, explore: 'haiku', review: 'opus' });
  assert.equal(file.enabled, true);
  // What the plugin module does: first family whose pattern matches.
  const routed = (description, type = 'general-purpose') => {
    const f = file.families.find((x) => new RegExp(x.pattern, 'i').test(`${description} ${type}`));
    return f ? [f.name, f.model] : ['other', null];
  };
  const cases = [
    'Find auth handlers', 'Explore the repo', 'Spec review task 3', 'Code quality review', 'Implement task 3',
    'Fix spec gaps task 3', 'Run the test suite', 'Plan the migration', 'Field check, no tools', 'Review tests',
  ];
  for (const d of cases) assert.equal(routed(d)[0], family(d, 'general-purpose'), d);
  assert.deepEqual(routed('Find auth handlers'), ['explore', 'haiku']);
  assert.deepEqual(routed('Spec review task 3'), ['spec-review', 'opus']); // the Review row covers spec reviews
  assert.deepEqual(routed('Implement task 3'), ['implement', null]); // row left at "agent decides"
  assert.deepEqual(routed('Field check, no tools'), ['other', null]);
  assert.deepEqual(RULE_ROWS.map(([k]) => k), ['explore', 'plan', 'implement', 'test', 'review']);
});

// The module's behaviour is run for real in mod.test.js. Here: the file the app
// writes is one the module's logic reads the same way.
test('routing.json as the app writes it is what the module applies', async () => {
  const { pathToFileURL } = require('url');
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'hooks', 'mod-logic.mjs')).href);
  const { chooseModel, parseRouting } = mod;
  assert.deepEqual([...mod.MODELS].sort(), MODELS.filter(Boolean).sort()); // the app offers what the module accepts ('' = agent decides)
  const written = routingFile({ enabled: true, explore: 'haiku', review: 'opus' });
  const rules = parseRouting(JSON.stringify(written));
  assert.ok(rules);
  assert.deepEqual(chooseModel(rules, { description: 'Find auth handlers', subagent_type: 'Explore' })?.model, 'haiku');
  assert.deepEqual(chooseModel(rules, { description: 'Spec review task 3' })?.model, 'opus');
  assert.equal(chooseModel(rules, { description: 'Implement task 3' }), null); // row left at "agent decides"
  // The module also has a .catch on its tool.call hook: a rule that fails changes nothing.
  const src = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'huddle-mod.ts'), 'utf8');
  assert.match(src, /\}\)\.catch\(\(\$, e, next\) => next\(e\)\)/);
});

test('store: a Routed notice marks the subagent, whichever event comes first', () => {
  const store = new Store();
  const S = { session_id: 's', cwd: 'C:\\p' };
  store.handle({ ...S, hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  // The module's notice can land before the Agent call's PreToolUse.
  store.handle({ ...S, hook_event_name: 'Routed', tool_use_id: 't1', family: 'explore', model: 'haiku' });
  store.handle({ ...S, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 't1', tool_input: { description: 'Find auth handlers', subagent_type: 'Explore', model: 'haiku' } });
  const [a] = store.snapshot()[0].team;
  assert.equal(store.snapshot()[0].team.length, 1);
  assert.equal(a.label, 'Find auth handlers');
  assert.equal(a.model, 'haiku');
  assert.equal(a.routed, 'explore');
});
