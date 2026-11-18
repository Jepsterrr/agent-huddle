// Model rules for subagents (Settings → "Choose subagent models").
//
// The app writes ~/.agent-huddle/routing.json; the plugin's module
// (hooks/huddle-mod.ts) reads it when an agent starts a subagent and, only if
// the agent chose no model itself, sets the model the rule gives that role.
// Off by default. No Electron in here.

const { FAMILIES } = require('./team');

// The rows in Settings, in order, and the models a row can cycle through
// ('' = the agent decides). The models are the ones Claude Code's Agent tool
// accepts (2.1.322).
const RULE_ROWS = [
  ['explore', 'Explore & search'],
  ['plan', 'Plan'],
  ['implement', 'Implement'],
  ['test', 'Test'],
  ['review', 'Review'],
];
const MODELS = ['', 'haiku', 'sonnet', 'opus', 'fable'];

const DEFAULT_ROUTING = { enabled: false, explore: '', plan: '', implement: '', test: '', review: '' };

// A stored value, cleaned: unknown keys dropped, unknown models back to ''.
function cleanRouting(raw) {
  const out = { ...DEFAULT_ROUTING };
  if (raw && typeof raw === 'object') {
    out.enabled = raw.enabled === true;
    for (const [key] of RULE_ROWS) if (MODELS.includes(raw[key])) out[key] = raw[key];
  }
  return out;
}

// The next model for a row when its button is clicked.
const nextModel = (current) => MODELS[(MODELS.indexOf(current) + 1) % MODELS.length];

// What routing.json holds: every family in match order, with the model its
// row sets (null: the agent decides). The module takes the first family whose
// pattern matches, as the team view does, and changes nothing when it is null.
function routingFile(routing) {
  const r = cleanRouting(routing);
  return {
    enabled: r.enabled,
    families: FAMILIES.map((f) => ({ name: f.name, pattern: f.pattern, model: r[f.rule] || null })),
  };
}

module.exports = { RULE_ROWS, MODELS, DEFAULT_ROUTING, cleanRouting, nextModel, routingFile };
