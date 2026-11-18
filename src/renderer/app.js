'use strict';

const api = window.huddle;
const $ = (sel) => document.querySelector(sel);

const root = $('#root');
const widget = $('#widget');
const listEl = $('#list');
const minisEl = $('#minis');

const STATUS = {
  idle: 'Idle',
  working: 'Working',
  permission: 'Needs your permission',
  question: 'Has a question for you',
  attention: 'Waiting for you',
  done: 'Done',
};
const NEEDS_YOU = new Set(['permission', 'question', 'attention']);
const MARK = { done: '✓', failed: '×', denied: '×' };

const BUDDY_SVG =
  '<svg class="buddy" viewBox="0 0 52 60" aria-hidden="true">' +
  '<rect class="skin leg l" x="13" y="45" width="6" height="12" rx="2"/>' +
  '<rect class="skin leg r" x="33" y="45" width="6" height="12" rx="2"/>' +
  '<rect class="skin" x="4" y="3" width="44" height="45" rx="8"/>' +
  '<rect class="face eye" x="15" y="18" width="6" height="8" rx="2"/>' +
  '<rect class="face eye" x="31" y="18" width="6" height="8" rx="2"/>' +
  '<rect class="face mouth" x="20" y="33" width="12" height="3" rx="1.500"/>' +
  '</svg>';
const ICON_GOTO = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="4"/><path d="M8 12l4-4M8.500 8H12v3.500"/></svg>';
const ICON_X = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>';

// Settings live in the main process (config.json) and arrive with every state
// update, so they are remembered across restarts. These are only the values
// used before the first update lands.
const DEFAULTS = {
  sound: true,
  collapsed: false,
  autoHide: true,
  hideFullscreen: true,
  protect: true,
  dnd: false,
  showUsage: true,
  usageTray: true,
  autoBuild: false,
  routing: { enabled: false },
  routingRows: [],
  startWithWindows: false,
  canDetectWindows: true,
};

let state = { sessions: [], align: { h: 'right', v: 'top' }, settings: DEFAULTS };
let openId = null;
let showSettings = false;
const cards = new Map(); // session id -> { li, refs, shownPending, stepEls }

const cfg = () => state.settings || DEFAULTS;

// Change a setting: shown at once here, saved by the main process.
function setSetting(key, value) {
  state.settings = { ...cfg(), [key]: value };
  api.set(key, value);
  render();
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// ---- render ----

function render() {
  root.dataset.h = state.align.h;
  root.dataset.v = state.align.v;
  renderBar();
  renderUsage();
  renderSettings();

  const seen = new Set();
  for (const s of state.sessions) {
    seen.add(s.id);
    let c = cards.get(s.id);
    if (!c) {
      c = makeCard(s);
      cards.set(s.id, c);
      listEl.append(c.li);
    }
    updateCard(c, s);
  }
  for (const [id, c] of cards) {
    if (!seen.has(id)) {
      c.li.remove();
      cards.delete(id);
      if (openId === id) openId = null;
    }
  }
}

function renderBar() {
  const n = state.sessions.length;
  setText($('#count'), n ? String(n) : '');
  const needs = state.sessions.some((s) => NEEDS_YOU.has(s.state));
  const busy = state.sessions.some((s) => s.state === 'working');
  $('#dot').dataset.tone = needs ? 'needs' : busy ? 'busy' : 'rest';

  const soundOn = cfg().sound;
  // The settings view is never folded away.
  const collapsed = cfg().collapsed && !showSettings;
  widget.classList.toggle('collapsed', collapsed);
  widget.classList.toggle('settings', showSettings);
  const gear = $('#b-settings');
  gear.setAttribute('aria-pressed', String(showSettings));
  gear.title = showSettings ? 'Back to agents' : 'Settings';
  gear.setAttribute('aria-label', gear.title);
  const collapse = $('#b-collapse');
  collapse.title = collapsed ? 'Show agents' : 'Collapse';
  collapse.setAttribute('aria-label', collapse.title);
  collapse.setAttribute('aria-expanded', String(!collapsed));

  const sound = $('#b-sound');
  sound.setAttribute('aria-pressed', String(soundOn));
  sound.title = soundOn ? 'Sound on: chimes when an agent needs you or finishes' : 'Sound off';
  sound.setAttribute('aria-label', sound.title);

  // One small square per agent, so a collapsed huddle still shows who needs you.
  minisEl.textContent = '';
  for (const s of state.sessions) {
    const m = el('span', 'mini');
    m.style.setProperty('--hue', s.hue);
    if (NEEDS_YOU.has(s.state)) m.dataset.needs = '';
    else if (s.state !== 'working') m.dataset.rest = '';
    m.title = `${label(s)}: ${statusLabel(s)}`;
    minisEl.append(m);
  }
}

// ---- quota and cost, from the statusLine bridge ----

const WINDOW_NAMES = [
  ['five_hour', '5h', '5-hour limit'],
  ['seven_day', '7d', 'Weekly limit'],
  ['spend_limit', '$', 'Spend limit'],
];

function resetText(sec) {
  if (typeof sec !== 'number') return '';
  const d = new Date(sec * 1000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameDay = d.toDateString() === new Date().toDateString();
  return `resets ${sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`}`;
}

function renderUsage() {
  const box = $('#usage');
  const usage = state.usage || {};
  const windows = WINDOW_NAMES.filter(([key]) => usage[key]);
  const costs = state.sessions.map((s) => s.cost).filter((c) => typeof c === 'number');
  const total = costs.reduce((a, b) => a + b, 0);
  box.hidden = !cfg().showUsage || (!windows.length && !costs.length);
  if (box.hidden) return;

  box.textContent = '';
  for (const [key, short, long] of windows) {
    const w = usage[key];
    const pct = Math.max(0, Math.round(w.pct));
    const m = el('span', 'um');
    m.dataset.level = pct >= 95 ? 'bad' : pct >= 80 ? 'warn' : 'ok';
    const track = el('span', 'um-track');
    const fill = el('span', 'um-fill');
    fill.style.width = `${Math.min(100, pct)}%`;
    track.append(fill);
    m.append(el('span', 'um-label', short), track, el('span', 'um-pct', `${pct}%`));
    const spend = key === 'spend_limit' && typeof w.usedUsd === 'number' && typeof w.limitUsd === 'number'
      ? ` ($${w.usedUsd.toFixed(2)} of $${w.limitUsd.toFixed(2)}${w.period ? `, ${w.period}` : ''})`
      : '';
    m.title = `${long}: ${pct}% used${spend}${w.resetsAt ? ` · ${resetText(w.resetsAt)}` : ''}`;
    box.append(m);
  }
  if (costs.length) {
    const c = el('span', 'um-cost', `$${total.toFixed(2)}`);
    c.title = `Cost so far in the ${costs.length} session${costs.length === 1 ? '' : 's'} shown (as Claude Code reports it)`;
    box.append(c);
  }
}

const label = (s) => s.title || s.name;
const statusLabel = (s) => (s.state === 'attention' ? `Waiting for you in ${s.host}` : STATUS[s.state] || s.state);

function makeCard(s) {
  const li = el('li', 'card');
  li.style.setProperty('--hue', s.hue);

  const main = el('button', 'main');
  main.type = 'button';
  main.innerHTML = BUDDY_SVG;
  const info = el('span', 'info');
  const title = el('span', 'title');
  const sub = el('span', 'sub');
  const prog = el('span', 'prog');
  const num = el('span', 'num');
  const lbl = el('span', 'lbl');
  const dots = el('span', 'tdots'); // one per subagent of the current work
  prog.append(num, lbl, dots);
  const track = el('span', 'track');
  const fill = el('span', 'fill');
  track.append(fill);
  for (const n of [title, sub, track]) n.style.display = 'block';
  info.append(title, sub, prog, track);
  main.append(info);
  main.addEventListener('click', () => {
    openId = openId === s.id ? null : s.id;
    render();
  });

  const acts = el('div', 'acts');
  const go = el('button', 'icon');
  go.type = 'button';
  go.title = "Go to this agent's window";
  go.setAttribute('aria-label', go.title);
  go.innerHTML = ICON_GOTO;
  go.addEventListener('click', () => api.focus(s.id));
  const x = el('button', 'icon');
  x.type = 'button';
  x.title = 'Remove this agent from the huddle';
  x.setAttribute('aria-label', x.title);
  x.innerHTML = ICON_X;
  x.addEventListener('click', () => api.dismiss(s.id));
  acts.append(go, x);

  const row = el('div', 'row');
  row.append(main, acts);
  const ask = el('div', 'ask');
  ask.hidden = true;
  const planBox = el('div', 'planbar');
  planBox.hidden = true;
  const teamBox = el('div', 'team');
  teamBox.hidden = true;
  const steps = el('ol', 'steps');
  steps.hidden = true;
  li.append(row, ask, planBox, teamBox, steps);

  return {
    li,
    refs: { main, title, sub, num, lbl, dots, fill, ask, plan: planBox, team: teamBox, steps },
    planPick: false, // choosing which session gets the plan
    shownPending: null,
    stepEls: new Map(),
    teamOpen: new Set(), // team rows opened to their full message
  };
}

function updateCard(c, s) {
  const { refs } = c;
  const open = s.id === openId;
  c.li.dataset.state = s.state;
  c.li.dataset.risk = s.pending[0]?.risk?.level || '';
  refs.main.setAttribute('aria-expanded', String(open));
  refs.main.title = s.cwd;
  setText(refs.title, label(s));
  setText(refs.sub, activity(s));

  // Progress: real numbers when the agent keeps a task list, otherwise just a mood.
  const p = s.progress;
  const calm = s.state === 'working' || s.state === 'idle';
  if (p && calm) {
    setText(refs.num, `${p.done}/${p.total}`);
    setText(refs.lbl, p.label);
    c.li.dataset.bar = 'count';
    refs.fill.style.width = `${Math.round((p.done / p.total) * 100)}%`;
  } else {
    setText(refs.num, p ? `${p.done}/${p.total}` : '');
    setText(refs.lbl, statusLabel(s));
    c.li.dataset.bar = s.state === 'working' ? 'busy' : s.state === 'idle' ? 'none' : 'full';
    refs.fill.style.width = '';
  }

  renderDots(c, s);
  const looping = (s.team || []).some((a) => a.status === 'running' && a.round >= LOOP_ROUND);
  c.li.toggleAttribute('data-loop', looping);
  refs.sub.title = looping ? 'The same step has come round several times on this task' : '';
  renderAsk(c, s);
  refs.plan.hidden = !open || !s.plan;
  if (open && s.plan) renderPlan(c, s);
  else c.planPick = false;
  refs.team.hidden = !open || !s.team?.length;
  if (open && s.team?.length) renderTeam(c, s);
  refs.steps.hidden = !open;
  if (open) renderSteps(c, s);
}

// ---- a plan this session wrote, and sending it to another session ----

const sessionName = (s) => s?.title || s?.name || 'session';

function renderPlan(c, s) {
  const box = c.refs.plan;
  const p = s.plan;
  const others = state.sessions.filter((x) => x.id !== s.id && x.canReceive);
  const sent = p.sent;
  const key = JSON.stringify([p.title, p.at, sent, c.planPick, others.map((x) => [x.id, sessionName(x)])]);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.textContent = '';

  const name = el('span', 'plan-name', p.title);
  name.title = p.path || 'Plan from plan mode';
  box.append(el('span', 'plan-icon', '▤'), name);

  const act = (text, fn, cls = 'btn link') => {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  };
  const right = el('span', 'plan-act');
  const build = p.build;
  if (build) {
    const name = `build: ${p.title}`;
    if (build.status === 'starting' || build.status === 'running') {
      const st = el('span', 'plan-state', build.status === 'starting' ? 'Starting a builder…' : 'Building in background');
      st.title = `${name}: its questions come here`;
      right.append(el('span', 'tdot', ''), st, act('Stop', () => api.stopBuild(s.id)));
      right.firstChild.dataset.v = 'run';
    } else if (build.status === 'done') {
      const word = { queued: ' · report on its way', delivered: ' · report sent here', failed: ' · report not delivered', unavailable: '' }[build.report] || '';
      const st = el('span', 'plan-state ok', `Built ✓${word}`);
      st.title = build.report === 'unavailable' ? `The report is on the "${name}" card` : build.message || '';
      right.append(st);
    } else {
      const st = el('span', 'plan-state bad', build.status === 'stopped' ? 'Build stopped' : 'Build did not start');
      st.title = build.reason || '';
      right.append(st, act(build.status === 'stopped' ? 'Build again' : 'Try again', () => api.buildPlan(s.id)));
    }
  } else if (sent) {
    const to = sent.toName || 'session';
    if (sent.status === 'queued') {
      right.append(el('span', 'plan-state', `Waiting for ${to}…`), act('Cancel', () => api.cancelPlan(s.id)));
    } else if (sent.status === 'failed') {
      right.append(el('span', 'plan-state bad', `${to} could not take it`), act('Send again', () => ((c.planPick = true), api.cancelPlan(s.id))));
    } else {
      const okText = el('span', 'plan-state ok', `Sent to ${to} ✓`);
      okText.title = sent.status === 'delivered' ? 'It arrived as a prompt there' : 'Collected; arriving';
      right.append(okText);
    }
  } else if (c.planPick) {
    const pick = el('span', 'plan-pick');
    pick.append(el('span', 'plan-state', 'To:'));
    for (const x of others) {
      const b = act(sessionName(x), () => {
        c.planPick = false;
        api.sendPlan(s.id, x.id);
      }, 'chip');
      b.style.setProperty('--hue', x.hue);
      b.title = x.cwd;
      pick.append(b);
    }
    pick.append(act('Cancel', () => ((c.planPick = false), renderPlan(c, s))));
    right.append(pick);
  } else {
    const b = act('Build', () => api.buildPlan(s.id));
    b.title = 'Start a background session that carries out this plan; its questions come here';
    right.append(b);
    if (others.length) right.append(act('Send to…', () => ((c.planPick = true), renderPlan(c, s))));
  }
  box.append(right);
}

// ---- the team: the session's subagents (see src/team.js) ----

const VERDICT_WORD = { pass: 'passed', fail: 'did not pass', warn: 'done, with concerns' };
const LOOP_ROUND = 3; // the same step this many times on one task: worth a look

const teamState = (a) => (a.status === 'running' ? 'run' : a.status === 'failed' ? 'fail' : a.verdict || 'done');
const ago = (ms) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

function teamMeta(a) {
  const bits = [];
  if (a.model) bits.push(a.routed ? `${a.model} (rule)` : a.model);
  if (a.round > 1) bits.push(`round ${a.round}`);
  bits.push(ago((a.endedAt || Date.now()) - a.startedAt));
  return bits.join(' · ');
}

// The collapsed card: one quiet dot per subagent, like a row of checks.
function renderDots(c, s) {
  const box = c.refs.dots;
  const t = s.team || [];
  const MAX = 10;
  const key = t.map((a) => `${teamState(a)}${a.round >= LOOP_ROUND ? '!' : ''}`).join('');
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.textContent = '';
  for (const a of t.slice(-MAX)) {
    const d = el('span', 'tdot');
    d.dataset.v = teamState(a);
    if (a.status === 'running' && a.round >= LOOP_ROUND) d.dataset.loop = '';
    d.title = `${a.label}${a.model ? ` · ${a.model}` : ''}${a.verdict ? ` · ${VERDICT_WORD[a.verdict]}` : a.status === 'running' ? ' · working' : ''}`;
    box.append(d);
  }
  if (t.length > MAX) box.prepend(el('span', 'tmore', `+${t.length - MAX}`));
}

// The opened card: one line per subagent; a click shows its last message.
function renderTeam(c, s) {
  const box = c.refs.team;
  box.textContent = '';
  for (const a of s.team) {
    const row = el('div', 'trow');
    row.dataset.v = teamState(a);
    if (a.status === 'running' && a.round >= LOOP_ROUND) row.dataset.loop = '';
    const head = el('div', 'thead');
    head.append(el('span', 'tmark'), el('span', 'tlabel', a.label), el('span', 'tmeta', teamMeta(a)));
    row.append(head);
    const key = a.key || a.id;
    const open = c.teamOpen.has(key);
    if (a.summary && !open) row.append(el('div', 'tsum', a.summary));
    if (open && a.message) {
      const full = el('div', 'tfull');
      appendMarkdown(full, a.message);
      row.append(full);
    }
    if (a.message) {
      row.classList.add('openable');
      row.addEventListener('click', () => {
        if (String(getSelection())) return;
        c.teamOpen.has(key) ? c.teamOpen.delete(key) : c.teamOpen.add(key);
        renderTeam(c, s);
      });
    }
    box.append(row);
  }
}

// What the agent is doing right now, in one line.
function activity(s) {
  const p = s.pending[0];
  // The question itself is in the box below, so this line does not repeat it.
  if (p) return p.kind === 'question' ? `Question: ${p.questions[0]?.header || 'needs your answer'}` : `Wants to: ${p.title || p.tool}`;
  if (s.state === 'attention') return s.note || 'Needs you';
  const tools = s.steps.filter((st) => st.kind === 'tool');
  // A subagent at work says who it is: "Spec review task 3 · opus · round 2".
  const busy = (s.team || []).filter((a) => a.status === 'running').at(-1);
  if (busy && (s.state === 'working' || s.state === 'done')) {
    return `${busy.label}${busy.model ? ` · ${busy.model}` : ''}${busy.round > 1 ? ` · round ${busy.round}` : ''}`;
  }
  if (s.state === 'working') {
    const running = [...tools].reverse().find((st) => st.status === 'running');
    return (running || tools.at(-1))?.title || 'Thinking';
  }
  const build = s.plan?.build;
  if (build && ['starting', 'running'].includes(build.status)) return `Building in background: ${s.plan.title}`;
  if (build?.status === 'done' && s.state === 'done') return `Built: ${s.plan.title}`;
  if (s.state === 'done' && s.plan && !s.plan.sent && !build) return `Plan ready: ${s.plan.title}`;
  if (s.state === 'done') return `Finished after ${tools.length} step${tools.length === 1 ? '' : 's'}`;
  return 'Waiting for a prompt';
}

// The card is only rebuilt when a different request is at the front, so
// half-typed answers survive the constant stream of updates.
function renderAsk(c, s) {
  const p = s.pending[0] || null;
  const key = p ? `${p.id}:${s.pending.length}` : null;
  if (key === c.shownPending) return;
  c.shownPending = key;
  const box = c.refs.ask;
  box.textContent = '';
  box.hidden = !p;
  if (!p) return;
  box.append(...(p.kind === 'question' ? questionParts(s, p) : permissionParts(s, p)));
  if (s.pending.length > 1) box.append(el('div', 'more', `+${s.pending.length - 1} more waiting after this`));
  c.li.scrollIntoView({ block: 'nearest' });
}

function inVSCodeButton(s, p) {
  const b = el('button', 'btn', s.host === 'the terminal' ? 'In terminal' : s.host === 'the editor' ? 'In editor' : `In ${s.host}`);
  b.type = 'button';
  b.title = `Answer this in ${s.host} instead`;
  b.addEventListener('click', () => {
    api.answer(p.id, { type: 'passthrough' });
    api.focus(s.id);
  });
  return b;
}

// Information only: the risk label never answers anything by itself.
const RISK_LABEL = { low: 'No known risks', medium: 'Medium risk', high: 'High risk' };
const DIFF_PREVIEW = 20;

function riskPill(risk) {
  const pill = el('div', 'risk');
  pill.dataset.level = risk.level;
  pill.append(el('span', 'risk-level', RISK_LABEL[risk.level] || risk.level));
  const why = risk.reasons.slice(0, 3).join(' · ');
  if (why) pill.append(el('span', 'risk-why', why));
  pill.title =
    (risk.reasons.length ? risk.reasons.join('\n') + '\n\n' : '') +
    'Pattern check only. It can miss things, so "no known risks" does not mean safe.';
  return pill;
}

function diffView(d) {
  const box = el('div', 'diff');
  if (d.note) box.append(el('div', 'diff-note', d.note));
  if (!d.lines.length) return box;
  const pre = el('pre', 'diff-lines');
  const draw = (all) => {
    pre.textContent = '';
    for (const l of all ? d.lines : d.lines.slice(0, DIFF_PREVIEW)) {
      const row = el('span', 'dl', l.t === '…' ? '…' : `${l.t} ${l.s}`);
      row.dataset.t = l.t === ' ' ? 'same' : l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'gap';
      pre.append(row);
    }
  };
  draw(false);
  box.append(pre);
  // The +/− counts are already on the preview line; this row is only for "show all".
  if (d.lines.length > DIFF_PREVIEW || d.truncated) {
    const counts = el('div', 'diff-count');
    box.append(counts);
    const more = el('button', 'btn link', `Show all ${d.total} lines`);
    more.type = 'button';
    let all = false;
    more.addEventListener('click', () => {
      all = !all;
      draw(all);
      more.textContent = all ? 'Show less' : `Show all ${d.total} lines`;
    });
    counts.append(more);
    if (d.truncated) counts.append(el('span', 'diff-note', ` (first ${d.lines.length} shown)`));
  }
  return box;
}

const fileName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';

// One line that says what would happen; the full command or diff opens below it.
function peekText(p) {
  if (p.diff) {
    const counts = p.diff.hidden ? 'contents hidden' : `+${p.diff.added} −${p.diff.removed}`;
    return `${fileName(p.detail) || p.title}   ${counts}`;
  }
  const first = String(p.detail || '').split('\n').find((l) => l.trim());
  return first || p.title || p.tool;
}

// A permission request, compact: what the card's own line does not already say
// (risk, a one-line preview) plus the buttons. Details open on demand, so
// several waiting agents still fit on screen.
function permissionParts(s, p) {
  const parts = [];

  const head = el('div', 'ask-head');
  // Who is asking comes first: a subagent's request is easy to mistake for the main agent's.
  if (p.agent) {
    const who = el('span', 'ask-agent', `subagent · ${p.agent}`);
    who.title = `Asked by a subagent (${p.agent}), not the main agent`;
    head.append(who);
  }
  if (p.risk) head.append(riskPill(p.risk));
  else head.append(el('span', 'ask-kicker', 'Permission'));
  parts.push(head);

  // Below the preview line: the diff (for file edits) and what "Always" adds.
  // A command is not repeated there; the preview line itself opens to show all of it.
  const full = el('div', 'ask-full');
  full.hidden = true;
  if (p.diff) {
    if (p.detail) full.append(el('div', 'diff-path', p.detail));
    full.append(diffView(p.diff));
  }
  if (p.always) full.append(el('div', 'always-note', `Always allow: ${p.always}`));

  const peek = el('button', 'peek');
  peek.type = 'button';
  peek.setAttribute('aria-expanded', 'false');
  const text = el('span', 'peek-text', peekText(p));
  if (!p.diff && p.detail) text.classList.add('full');
  peek.append(el('span', 'peek-chev', '▸'), text);
  peek.title = 'Show the full request';
  peek.addEventListener('click', () => {
    // Selecting text in the opened command should not fold it away.
    if (String(getSelection())) return;
    const open = peek.getAttribute('aria-expanded') !== 'true';
    peek.setAttribute('aria-expanded', String(open));
    full.hidden = !open;
    if (text.classList.contains('full')) text.textContent = open ? p.detail : peekText(p);
    peek.title = open ? 'Hide details' : 'Show the full request';
  });
  parts.push(peek, full);

  const row = el('div', 'btns compact');
  const allow = el('button', 'btn primary', 'Allow');
  const deny = el('button', 'btn danger', 'Deny');
  allow.type = deny.type = 'button';
  allow.addEventListener('click', () => api.answer(p.id, { type: 'allow' }));
  deny.addEventListener('click', () => api.answer(p.id, { type: 'deny' }));
  row.append(allow);
  if (p.always) {
    // Offered only when Claude Code suggested a rule; the tooltip and the
    // details say exactly what it adds.
    const always = el('button', 'btn', 'Always');
    always.type = 'button';
    always.title = `Always allow: ${p.always}`;
    always.addEventListener('click', () => api.answer(p.id, { type: 'always' }));
    row.append(always);
  }
  row.append(deny, inVSCodeButton(s, p));
  parts.push(row);
  return parts;
}

// A question, compact: the options are chips (their descriptions show on
// hover), and "Other…" opens a text field only when wanted.
function questionParts(s, p) {
  const parts = [];
  const send = el('button', 'btn primary', 'Send');
  send.type = 'button';
  const blocks = [];
  let refresh = () => {}; // set below, once the questions are built

  // Several questions are shown one at a time, like the editor does: picking
  // an option moves on, Back goes back, Send comes on the last one.
  const total = p.questions.length;
  let at = 0;
  const back = el('button', 'btn', 'Back');
  back.type = 'button';
  const show = (i) => {
    at = Math.max(0, Math.min(total - 1, i));
    blocks.forEach((b, k) => (b.el.hidden = k !== at));
    back.hidden = at === 0;
    refresh();
  };
  const advance = () => {
    if (at < total - 1 && blocks[at].value()) show(at + 1);
  };

  p.questions.forEach((q, qi) => {
    const block = el('div', 'q-block');
    const text = el('div', 'q-text');
    if (total > 1) text.append(el('span', 'q-count', `${qi + 1}/${total}`));
    if (q.header) text.append(el('span', 'q-head', q.header));
    text.append(document.createTextNode(q.question));
    if (q.multiSelect) text.append(el('span', 'q-hint', ' (pick any)'));
    text.title = q.question;
    block.append(text);

    const picked = new Set();
    const buttons = [];
    const chips = el('div', 'chips');
    const other = el('input', 'other');
    other.hidden = true;
    for (const o of q.options || []) {
      const b = el('button', 'opt', o.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      if (o.description) {
        b.title = o.description;
        b.setAttribute('aria-description', o.description);
      }
      b.addEventListener('click', () => {
        if (q.multiSelect) {
          picked.has(o.label) ? picked.delete(o.label) : picked.add(o.label);
        } else {
          const was = picked.has(o.label);
          picked.clear();
          if (!was) picked.add(o.label);
          other.value = '';
        }
        for (const x of buttons) x.el.setAttribute('aria-pressed', String(picked.has(x.label)));
        refresh();
        // One pick answers a single-choice question: go on after a moment, so the choice is seen.
        if (!q.multiSelect && picked.size && qi === at) setTimeout(() => qi === at && advance(), 180);
      });
      buttons.push({ el: b, label: o.label });
      chips.append(b);
    }
    const otherChip = el('button', 'opt ghost', 'Other…');
    otherChip.type = 'button';
    otherChip.addEventListener('click', () => {
      other.hidden = false;
      otherChip.hidden = true;
      typeInto(other);
    });
    chips.append(otherChip);
    block.append(chips);

    other.type = 'text';
    other.placeholder = 'Something else…';
    other.setAttribute('aria-label', `Other answer: ${q.question}`);
    other.addEventListener('input', () => {
      if (!q.multiSelect && other.value.trim()) {
        picked.clear();
        for (const x of buttons) x.el.setAttribute('aria-pressed', 'false');
      }
      refresh();
    });
    other.addEventListener('mousedown', (e) => {
      if (document.activeElement === other) return;
      e.preventDefault();
      typeInto(other);
    });
    other.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') (at < total - 1 ? advance : () => !send.disabled && send.click())();
    });
    block.append(other);
    block.hidden = qi !== 0;
    parts.push(block);
    blocks.push({ el: block, question: q.question, value: () => [...picked, other.value.trim()].filter(Boolean).join(', ') });
  });

  // The main button is "Next" until the last question, then "Send".
  refresh = () => {
    const last = at === total - 1;
    send.textContent = last ? 'Send' : 'Next';
    send.disabled = last ? !blocks.every((b) => b.value()) : !blocks[at].value();
  };
  send.addEventListener('click', () => {
    if (at < total - 1) return advance();
    const answers = {};
    for (const b of blocks) answers[b.question] = b.value();
    api.answer(p.id, { type: 'answers', answers });
  });
  back.addEventListener('click', () => show(at - 1));

  const row = el('div', 'btns compact');
  row.append(back, send, inVSCodeButton(s, p));
  parts.push(row);
  show(0);
  return parts;
}

// The huddle window does not take the focus on a click (so it stays out of
// Alt+Tab). A text field asks for the keyboard first, and lets go when done.
function typeInto(input) {
  api.keyboard(true);
  setTimeout(() => input.isConnected && input.focus(), 60);
}
document.addEventListener('focusout', (e) => {
  if (!(e.target instanceof HTMLInputElement)) return;
  setTimeout(() => {
    if (!(document.activeElement instanceof HTMLInputElement)) api.keyboard(false);
  }, 0);
});

function renderSteps(c, s) {
  const box = c.refs.steps;
  const fresh = c.stepEls.size === 0;
  const stick = fresh || box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  const seen = new Set();
  // With the team list above, the "start subagent" steps would say it twice.
  const hideAgents = (s.team || []).length > 0;
  for (const st of s.steps) {
    if (hideAgents && (st.tool === 'Agent' || st.tool === 'Task')) continue;
    seen.add(st.id);
    let li = c.stepEls.get(st.id);
    if (!li) {
      li = makeStep(st);
      c.stepEls.set(st.id, li);
      box.append(li);
    }
    li.dataset.status = st.status || '';
    setText(li.querySelector('.mark'), MARK[st.status] || '');
    setText(li.querySelector('.meta'), meta(st));
    setText(li.querySelector('.detail'), st.status === 'failed' && st.error ? st.error : st.detail || '');
  }
  for (const [id, li] of c.stepEls) {
    if (!seen.has(id)) {
      li.remove();
      c.stepEls.delete(id);
    }
  }
  if (stick) box.scrollTop = box.scrollHeight;
  if (fresh) c.li.scrollIntoView({ block: 'nearest' });
}

function makeStep(st) {
  const li = el('li', 'step');
  li.dataset.kind = st.kind;
  const t = el('span', 't');
  if (st.kind === 'prompt') t.append(el('span', 'who-tag', 'You'));
  if (st.kind === 'message') t.append(el('span', 'who-tag', 'Agent'));
  if (st.kind === 'prompt' || st.kind === 'message') appendMarkdown(t, st.title || '');
  else t.append(document.createTextNode(st.title || ''));
  li.append(el('span', 'mark'), t, el('span', 'meta'), el('span', 'detail'));
  li.addEventListener('click', () => {
    if (!String(getSelection())) li.classList.toggle('expanded');
  });
  return li;
}

// Light Markdown (see markdown.js), built with textContent only.
function appendMarkdown(node, text) {
  const md = window.HuddleMarkdown;
  if (!md) return node.append(document.createTextNode(text));
  for (const seg of md.parse(text)) {
    let n = seg.code ? el('code', null, seg.s) : document.createTextNode(seg.s);
    if (seg.i) {
      const em = el('em');
      em.append(n);
      n = em;
    }
    if (seg.b || seg.h) {
      const strong = el('strong', seg.h ? 'md-h' : null);
      strong.append(n);
      n = strong;
    }
    node.append(n);
  }
}

function meta(st) {
  const parts = [];
  if (st.agent) parts.push(st.agent);
  if (st.status === 'denied') parts.push('denied');
  if (typeof st.ms === 'number') parts.push(st.ms < 1000 ? `${st.ms} ms` : `${(st.ms / 1000).toFixed(1)} s`);
  return parts.join(' · ');
}

// ---- sound: a short chime when an agent needs you, a softer one when it finishes ----

let audio = null;
const lastState = new Map();
// Set when the huddle reappears: an agent that finished while it was hidden
// (you were in VS Code and saw it there) should not chime late.
let quietDone = false;

function chime(notes) {
  if (!cfg().sound) return;
  try {
    audio = audio || new AudioContext();
    let t = audio.currentTime + 0.02;
    for (const [freq, len] of notes) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + len + 0.02);
      t += len * 0.6;
    }
  } catch {}
}

function soundFor(sessions) {
  let needs = false;
  let done = false;
  for (const s of sessions) {
    const before = lastState.get(s.id);
    if (before !== s.state) {
      if (NEEDS_YOU.has(s.state) && !NEEDS_YOU.has(before)) needs = true;
      else if (s.state === 'done' && before === 'working') done = true;
    }
    lastState.set(s.id, s.state);
  }
  for (const id of [...lastState.keys()]) if (!sessions.some((s) => s.id === id)) lastState.delete(id);
  if (needs) chime([[660, 0.16], [880, 0.26]]);
  else if (done && !quietDone) chime([[523, 0.3]]);
  quietDone = false;
}

// ---- header buttons ----

$('#b-sound').addEventListener('click', () => {
  setSetting('sound', !cfg().sound);
  if (cfg().sound) chime([[880, 0.18]]);
});
$('#b-collapse').addEventListener('click', () => {
  if (showSettings) return openSettings(false);
  setSetting('collapsed', !cfg().collapsed);
});
$('#b-settings').addEventListener('click', () => openSettings(!showSettings));
$('#b-hide').addEventListener('click', () => {
  openSettings(false);
  api.hide();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (showSettings) openSettings(false);
  else if (openId) {
    openId = null;
    render();
  }
});

// ---- settings view ----

// [key, title, hint, needs window detection]
const SETTINGS = [
  ['sound', 'Sound', 'Chime when an agent needs you or finishes'],
  ['autoHide', "Hide when I'm with the agent", 'Stay out of the way while its own window is in front', true],
  ['hideFullscreen', 'Hide over full-screen', 'Films, games and presentations', true],
  ['protect', 'Hide from screen sharing', 'Also keeps it out of recordings and screenshots'],
  ['showUsage', 'Show quota and cost', '5-hour and weekly limits under the header'],
  ['usageTray', 'Warn near the limit', 'Tray icon turns red at 90% of a quota'],
  ['autoBuild', 'Build plans automatically', 'A finished plan starts a background session; its questions come here'],
  ['dnd', 'Do not disturb', 'Stay hidden. Every question is asked in the editor only'],
  ['startWithWindows', 'Start with Windows', 'Otherwise it starts with your first Claude Code session'],
];
const switches = new Map();

// The main process keeps the huddle on screen while this view is open.
function openSettings(open) {
  if (open === showSettings) return;
  showSettings = open;
  api.settingsOpen(open);
  render();
}

function buildSettings() {
  const box = $('#settings');
  for (const [key, title, hint, needsDetection] of SETTINGS) {
    const sw = el('button', 'switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.dataset.key = key;
    const text = el('span', 'sw-text');
    text.append(el('span', 'sw-title', title), el('span', 'sw-hint', hint));
    sw.append(text, el('span', 'sw-knob'));
    sw.addEventListener('click', () => setSetting(key, !cfg()[key]));
    switches.set(key, { sw, needsDetection });
    box.append(sw);
  }
  // Subagent models: one switch; when on, one row per role whose value
  // button steps through the models (no dropdowns: the huddle takes no focus).
  const rSw = el('button', 'switch');
  rSw.type = 'button';
  rSw.setAttribute('role', 'switch');
  const rText = el('span', 'sw-text');
  rText.append(
    el('span', 'sw-title', 'Choose subagent models'),
    el('span', 'sw-hint', 'For subagents the agent gives no model (plugin). Implement also picks the builder’s model')
  );
  rSw.append(rText, el('span', 'sw-knob'));
  rSw.addEventListener('click', () => api.setRouting('enabled'));
  const rRows = el('div', 'rrows');
  routingUi.sw = rSw;
  routingUi.rows = rRows;
  box.append(rSw, rRows);

  const row = el('div', 'btns');
  const reset = el('button', 'btn', 'Reset position');
  const quit = el('button', 'btn danger', 'Quit Agent Huddle');
  reset.type = quit.type = 'button';
  reset.addEventListener('click', () => api.resetPosition());
  quit.addEventListener('click', () => api.quit());
  row.append(reset, quit);
  box.append(row, el('p', 'sw-note', 'Changes are saved as you make them.'));
}

function renderSettings() {
  $('#settings').hidden = !showSettings;
  for (const [key, { sw, needsDetection }] of switches) {
    sw.setAttribute('aria-checked', String(!!cfg()[key]));
    sw.disabled = !!needsDetection && !cfg().canDetectWindows;
  }
  renderRouting();
}

const routingUi = { sw: null, rows: null, key: '' };

function renderRouting() {
  const r = cfg().routing || { enabled: false };
  const rows = cfg().routingRows || [];
  if (!routingUi.sw) return;
  routingUi.sw.setAttribute('aria-checked', String(!!r.enabled));
  routingUi.rows.hidden = !r.enabled;
  const key = JSON.stringify([r, rows]);
  if (key === routingUi.key) return;
  routingUi.key = key;
  routingUi.rows.textContent = '';
  for (const [k, label] of rows) {
    const model = r[k] || '';
    const row = el('div', 'rrow');
    const val = el('button', 'rval', model || 'agent decides');
    val.type = 'button';
    if (!model) val.dataset.auto = '';
    val.title = 'Click for the next model';
    val.setAttribute('aria-label', `${label}: ${model || 'agent decides'}. Click for the next model`);
    val.addEventListener('click', () => api.setRouting(k));
    row.append(el('span', 'rlabel', label), val);
    routingUi.rows.append(row);
  }
}

buildSettings();
api.onOpenSettings(() => {
  showSettings = true;
  render();
});

// ---- click-through: the window only takes the mouse over real UI ----

let hit = false;
let dragging = false;

function setHit(next) {
  if (next === hit) return;
  hit = next;
  api.setHit(hit);
}

window.addEventListener('mousemove', (e) => {
  if (dragging) return;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  setHit(!!(under && under.closest('[data-hit]')));
});
document.addEventListener('mouseleave', () => {
  if (!dragging) setHit(false);
});
// The window was hidden and is back, click-through again: forget what we claimed.
api.onShown(() => {
  hit = false;
  quietDone = true;
});

// ---- dragging the huddle around by its header ----

const bar = $('#bar');
bar.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  dragging = true;
  bar.setPointerCapture(e.pointerId);
  api.dragStart();
});
bar.addEventListener('pointermove', () => dragging && api.dragMove());
const endDrag = () => {
  if (!dragging) return;
  dragging = false;
  api.dragEnd();
};
bar.addEventListener('pointerup', endDrag);
bar.addEventListener('pointercancel', endDrag);

// ---- go ----

api.onState((next) => {
  state = next;
  soundFor(state.sessions);
  render();
});
api.ready();
