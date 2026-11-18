// The decisions of Agent Huddle's plugin module (huddle-mod.ts), with no `$`
// in them, so they can be tested in plain Node (test/mod.test.js). The module
// only does the I/O around these: reading files, fetching, submitting.
// Types: mod-logic.d.mts.

export const MODELS = ['sonnet', 'opus', 'haiku', 'fable'];

// Built-in subagent types whose model comes from no definition of their own
// (forks always inherit the parent's model, so they are not here).
export const BUILTIN_AGENTS = ['general-purpose', 'Explore', 'Plan'];

export const isModel = (m) => typeof m === 'string' && MODELS.includes(m);

// runtime.json as the app writes it, or null when it is not usable.
export function parseRuntime(text) {
  try {
    const r = JSON.parse(text);
    return r && Number.isInteger(r.port) && r.port > 0 && r.port < 65536 && typeof r.token === 'string' && r.token ? r : null;
  } catch {
    return null;
  }
}

// routing.json, or null when it is off, broken or has no rules.
export function parseRouting(text) {
  try {
    const r = JSON.parse(text);
    return r && r.enabled === true && Array.isArray(r.families) ? r : null;
  } catch {
    return null;
  }
}

// Which model a rule gives this Agent call, or null to leave the call as it is.
//   input: { model?, subagent_type?, description? }
// The agent's own model always wins; only Claude Code's built-in subagents are
// touched (a custom or plugin agent may set its model in its definition); a
// rule with a broken pattern or a model that is not one of MODELS is skipped.
export function chooseModel(routing, input) {
  if (!routing || !input || input.model) return null;
  if (input.subagent_type && !BUILTIN_AGENTS.includes(input.subagent_type)) return null;
  const text = `${input.description ?? ''} ${input.subagent_type ?? ''}`;
  for (const f of routing.families) {
    if (!f || typeof f.pattern !== 'string') continue;
    let hit;
    try {
      hit = new RegExp(f.pattern, 'i').test(text);
    } catch {
      continue;
    }
    if (hit) return isModel(f.model) ? { family: f.name, model: f.model } : null;
  }
  return null;
}

// The StatusLine event for the app, from a `session.measure` input: the same
// fields `hook.js status` sends.
export function statusEvent(e) {
  const limits = Array.isArray(e?.rateLimits) ? e.rateLimits : [];
  const windows = {};
  for (const w of limits) {
    const at = w.resetsAt ? Date.parse(w.resetsAt) / 1000 : NaN;
    windows[w.kind] = { used_percentage: w.percentUsed, resets_at: Number.isFinite(at) ? at : undefined };
  }
  return {
    hook_event_name: 'StatusLine',
    source: 'mod',
    cost_usd: e?.cost?.usd,
    context_pct: e?.context?.percent,
    rate_limits: limits.length ? windows : undefined,
  };
}

// The app's answer to an inbox check: the plan to submit, or null.
export function inboxMessage(status, text) {
  if (status !== 200) return null; // 204: nothing waiting
  try {
    const msg = JSON.parse(text)?.huddle;
    return msg && typeof msg.submit === 'string' && msg.submit ? { submit: msg.submit, fromId: msg.fromId } : null;
  } catch {
    return null;
  }
}
