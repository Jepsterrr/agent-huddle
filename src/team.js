// Reads a session's subagents ("the team") out of hook events: what role each
// plays, which model it ran on, and what it concluded. No Electron in here.
//
// The data (measured on Claude Code 2.1.322): the Agent tool call carries
// `description`, `subagent_type` and `model` (requested); its PostToolUse
// result carries `agentId` and `resolvedModel`; SubagentStart/Stop carry
// `agent_id` (= agentId) and, on stop, `last_assistant_message`.
//
// Everything here is a reading for the human, like the risk label: it never
// changes what an agent does.

const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// Role families, first match wins. One table for the team view and for the
// model rules (routing.js writes these patterns for the plugin module), so
// what the list calls a role is exactly what a rule applies to.
// `rule` is the row in Settings that sets the family's model.
const FAMILIES = [
  { name: 'spec-review', rule: 'review', pattern: String.raw`spec[\s\S]*(review|complian|check)|(review|complian|check)[\s\S]*spec` },
  { name: 'review', rule: 'review', pattern: String.raw`review|quality|audit` },
  { name: 'test', rule: 'test', pattern: String.raw`\btest|verif` },
  { name: 'explore', rule: 'explore', pattern: String.raw`explor|search|find|investigat|index|research|look ?up|scan` },
  { name: 'plan', rule: 'plan', pattern: String.raw`plan|design|architect` },
  { name: 'implement', rule: 'implement', pattern: String.raw`implement|build|fix|write|refactor|add|creat|update|change|migrat` },
];
const COMPILED = FAMILIES.map((f) => ({ ...f, re: new RegExp(f.pattern, 'i') }));

// A role family, so the same step can be counted when it comes round again
// (an implementer fixing what a reviewer found, then the reviewer again).
function family(description, type) {
  const t = `${description || ''} ${type || ''}`;
  return (COMPILED.find((f) => f.re.test(t)) || { name: 'other' }).name;
}

// 'claude-sonnet-5-5' -> 'sonnet'. Unknown ids keep a short form.
function shortModel(id) {
  const m = /(haiku|sonnet|opus|fable|mythos)/i.exec(String(id || ''));
  if (m) return m[1].toLowerCase();
  return id ? clip(String(id).replace(/^claude-/, ''), 14) : '';
}

// What a subagent's last message concluded: 'pass', 'fail', 'warn' or null.
// Understands the statuses superpowers' implementers report (DONE,
// DONE_WITH_CONCERNS, NEEDS_CONTEXT, BLOCKED) and plain reviewer verdicts.
function verdict(text) {
  const head = String(text || '').slice(0, 800);
  if (!head.trim()) return null;
  if (/\b(BLOCKED|NEEDS_CONTEXT)\b/.test(head)) return 'fail';
  if (/\bDONE_WITH_CONCERNS\b/.test(head)) return 'warn';
  if (/❌|\bnot (spec[- ])?compliant\b|\bnon-compliant\b|\bchanges requested\b|\brejected\b|\bnot approved\b|\btests? fail(ed|ing|s)?\b|\b\d+ (issues|problems|gaps)\b/i.test(head)) return 'fail';
  if (/✅|\bapproved\b|\b(spec[- ])?compliant\b|\blgtm\b|\ball (\d+ )?(tests? )?pass(ed|ing)?\b|\bDONE\b/i.test(head)) return 'pass';
  return null;
}

// The first line worth reading, without Markdown marks. Lines that only name
// what follows ("Issues:", "## Result", "Status: DONE") are skipped: the
// verdict is drawn beside the summary already.
function summary(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/^[\s#>*\-•✓✗☑☐]+/u, '')
        .replace(/\s*[✅❌]\s*/gu, ' ')
        .replace(/[*_`]+/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim()
    )
    .filter((l) => l.length > 1);
  const empty = (l) =>
    /^(status:?\s*)?(done|done_with_concerns|blocked|needs_context|approved|lgtm)\.?$/i.test(l) ||
    (/:$/.test(l) && l.length <= 40) ||
    /^(result|results|summary|review|report|spec review|code review|findings)$/i.test(l);
  const line = lines.find((l) => !empty(l)) || lines[0] || '';
  return clip(line.replace(/^status:\s*(done|done_with_concerns)\s*[-–:]\s*/i, ''), 100);
}

// A short label for the role, from the call's description, else its type.
function label(description, type) {
  const d = String(description || '').trim();
  if (d) return clip(d, 40);
  const t = String(type || 'subagent').replace(/^.*:/, '');
  return clip(t, 40);
}

module.exports = { FAMILIES, family, shortModel, verdict, summary, label };
