// Session state, built from Claude Code hook events. No Electron in here.
//
// One session = one buddy. Each session has:
//   state    'idle' | 'working' | 'permission' | 'question' | 'attention' | 'done'
//   steps    what it has done, oldest first
//   pending  permission requests / questions the hook is waiting on an answer for

const { EventEmitter } = require('events');
const os = require('os');
const { describe, permissionDetail, describeSuggestions, clip, base } = require('./tools');
const { assess } = require('./risk');
const { diffForTool } = require('./diff');
const { mergeUsage, pruneUsage } = require('./usage');
const team = require('./team');
const { builderName, reportPrompt, isBuilderPrompt } = require('./builder');

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const MAX_TEAM = 40;
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

// A plan file: Markdown in a plans folder (superpowers writes
// docs/superpowers/plans/YYYY-MM-DD-<name>.md) or with "plan" in its name.
const isPlanFile = (p) =>
  /\.md$/i.test(p || '') && (/(^|[\\/])plans?[\\/][^\\/]+$/i.test(p) || /plan[^\\/]*\.md$/i.test(base(p)));
// "2026-11-18-retry-logic.md" -> "retry-logic"
const planTitle = (p) => base(p).replace(/\.md$/i, '').replace(/^\d{4}-\d{2}-\d{2}[-_ ]?/, '') || 'plan';
// A mod that polled within this long can take a plan.
const MOD_ALIVE_MS = 15_000;

const MAX_STEPS = 300;
const MOVED_ON_MS = 2000;

// Tools whose "permission" is really a dialog we can't answer with allow/deny.
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// Events allowed to bring back a buddy the user has dismissed.
const REVIVING = new Set(['SessionStart', 'UserPromptSubmit', 'PermissionRequest']);

class Store extends EventEmitter {
  // opts.readFile(path) -> text | null (missing) | undefined (do not compare); used for Write diffs.
  constructor(opts = {}) {
    super();
    this.home = opts.home || os.homedir();
    this.readFile = opts.readFile || null;
    this.usage = {}; // account quota windows, see usage.js
    this.outbox = new Map(); // session id -> plan waiting for that session's module to collect
    this.builders = new Map(); // builder session id -> planner session id
    this.sessions = new Map();
    this.dismissed = new Set();
    this.waiters = new Map(); // pendingId -> { sessionId, pending, input, resolve }
    this.seq = 0;
  }

  snapshot() {
    return [...this.sessions.values()];
  }

  // Quota windows with expired ones dropped.
  usageNow() {
    return pruneUsage(this.usage);
  }

  // Returns null, or { promise, cancel } when the hook should wait for the user.
  handle(evt, mode = 'notify', meta = {}) {
    if (!evt || typeof evt.session_id !== 'string' || typeof evt.hook_event_name !== 'string') return null;
    const name = evt.hook_event_name;
    const id = evt.session_id;

    if (mode === 'status' || name === 'StatusLine') {
      this._status(evt);
      return null;
    }
    if (name === 'Inbox') return this._inbox(evt);
    if (name === 'Delivered') {
      this._delivered(evt);
      return null;
    }

    if (name === 'SessionEnd') {
      this._end(id);
      return null;
    }

    if (this.dismissed.has(id)) {
      if (!REVIVING.has(name) && mode !== 'wait') return null;
      this.dismissed.delete(id);
    }

    const s = this._session(evt);
    this._seenPid(s, meta.ppid);
    // A background builder Huddle started: name its card after the plan.
    const plannerId = this.builders.get(s.id);
    if (plannerId && !s.builderOf) {
      s.builderOf = plannerId;
      const planner = this.sessions.get(plannerId);
      s.title = builderName(planner?.plan?.title);
    }
    const held = this._apply(s, name, evt, mode);
    s.updatedAt = Date.now();
    this._changed();
    return held;
  }

  _apply(s, name, evt, mode) {
    const tool = evt.tool_name;
    const input = evt.tool_input || {};
    const agent = evt.agent_id ? evt.agent_type || 'subagent' : '';

    switch (name) {
      case 'SessionStart':
        if (evt.session_title) s.title = clip(evt.session_title, 80);
        return null;

      case 'UserPromptSubmit':
        this._cancelAll(s.id);
        if (evt.session_title) s.title = clip(evt.session_title, 80);
        s.state = 'working';
        s.note = '';
        // A finished task list belongs to the previous piece of work.
        if (s.progress && s.progress.done === s.progress.total) {
          s.tasks = [];
          s.progress = null;
        }
        // A new request starts a new team, unless subagents are still at work.
        if (!s.team.some((a) => a.status === 'running')) s.team = [];
        // Claude Code hands some events to the model as if the user typed them
        // (a background task finishing). Show those as what they are, not as "You".
        const note = systemNotice(evt.prompt);
        if (note) this._step(s, { kind: 'agent', title: note });
        else this._step(s, { kind: 'prompt', title: clip(evt.prompt, 600) });
        this._linkByPrompt(s, evt.prompt);
        return null;

      case 'PreToolUse': {
        // Never hold PreToolUse: it runs before the tool, so holding it keeps
        // Claude Code from showing the question in the editor at all. Questions
        // are held on PermissionRequest instead, which is shown in both places.
        // (Older installs still send AskUserQuestion here in 'wait' mode.)
        if (mode === 'wait') return null;
        if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
          s.tasks = input.todos.map((t, i) => ({
            id: String(i),
            subject: clip(t.content, 80),
            activeForm: clip(t.activeForm, 80),
            status: t.status,
          }));
          s.progress = progress(s.tasks);
        }
        this._movedOn(s, evt);
        if (AGENT_TOOLS.has(tool)) this._teamCall(s, evt);
        // Plan mode hands its plan over here (and in planFilePath, when it saved one).
        if (tool === 'ExitPlanMode' && (input.plan || input.planFilePath)) {
          this._setPlan(s, { path: input.planFilePath, text: input.plan });
        }
        const key = evt.tool_use_id;
        if (!key || !s.steps.some((st) => st.key === key)) {
          this._step(s, { kind: 'tool', key, tool, agent, status: 'running', ...describe(tool, input) });
        }
        if (!s.pending.length) s.state = 'working';
        return null;
      }

      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const failed = name === 'PostToolUseFailure';
        // The tool ran (or failed) without us: the prompt was answered in VS Code.
        const sig = signature(tool, input);
        for (const [id, w] of [...this.waiters]) {
          if (w.sessionId !== s.id) continue;
          // A question answered in the editor comes back with `answers` added, so
          // its input no longer matches; the tool name is enough there.
          const same = w.sig === sig || (w.pending.kind === 'question' && w.pending.tool === tool);
          if (same) this._settle(id, null, 'working');
        }
        let st = evt.tool_use_id && s.steps.find((x) => x.key === evt.tool_use_id);
        if (!st) st = this._step(s, { kind: 'tool', key: evt.tool_use_id, tool, agent, ...describe(tool, input) });
        st.status = failed ? 'failed' : 'done';
        if (typeof evt.duration_ms === 'number') st.ms = evt.duration_ms;
        if (failed && evt.error) st.error = clip(evt.error, 400);
        if (!failed) this._trackTask(s, tool, input, evt.tool_response);
        if (AGENT_TOOLS.has(tool)) this._teamCalled(s, evt, failed);
        // The main agent wrote a plan file (a subagent's drafts do not count).
        if (!failed && !evt.agent_id && FILE_TOOLS.has(tool) && isPlanFile(input.file_path)) {
          this._setPlan(s, { path: input.file_path });
        } else if (!failed && s.plan && !s.plan.underway && this._carriesOut(s, tool, input, evt)) {
          // The session went on to carry out its own plan: no builder for it.
          s.plan.underway = true;
        }
        if (!s.pending.length) s.state = 'working';
        return null;
      }

      case 'PermissionRequest': {
        if (tool === 'AskUserQuestion' && mode === 'wait' && Array.isArray(input.questions)) {
          return this._pend(s, { kind: 'question', tool, questions: input.questions }, input, evt.agent_id);
        }
        if (INTERACTIVE_TOOLS.has(tool) || mode !== 'wait') {
          if (!s.pending.length) {
            s.state = 'attention';
            s.note =
              tool === 'ExitPlanMode'
                ? 'Has a plan for you to review'
                : tool === 'AskUserQuestion'
                  ? 'Has a question for you'
                  : `Wants to: ${describe(tool, input).title}`;
          }
          return null;
        }
        const d = describe(tool, input);
        const suggestions = evt.permission_suggestions;
        // Risk and diff are shown to the user only; they never change the decision.
        const risk = assess(tool, input, {
          cwd: evt.cwd || s.cwd,
          home: this.home,
          extraDirs: [evt.scratchpad_dir].filter(Boolean),
        });
        const diff = diffForTool(tool, input, this.readFile);
        return this._pend(
          s,
          {
            kind: 'permission',
            tool,
            agent,
            title: d.title,
            detail: diff ? input.file_path : permissionDetail(tool, input),
            always: describeSuggestions(suggestions), // what "Always allow" would do, or ''
            risk,
            diff,
          },
          input,
          evt.agent_id,
          suggestions
        );
      }

      case 'Notification': {
        const t = evt.notification_type;
        const needsUser = t === 'permission_prompt' || t === 'elicitation_dialog' || t === 'agent_needs_input';
        // Keep the more specific note a PermissionRequest may already have left.
        if (needsUser && !s.pending.length && s.state !== 'done' && s.state !== 'attention') {
          s.state = 'attention';
          s.note = clip(evt.message || '', 200);
        }
        return null;
      }

      case 'Stop':
        this._cancelAll(s.id);
        for (const st of s.steps) if (st.status === 'running') st.status = 'done';
        s.state = 'done';
        s.note = '';
        if (evt.last_assistant_message) {
          this._step(s, { kind: 'message', title: clip(evt.last_assistant_message, 1500) });
        }
        if (this.builders.has(s.id)) this._builderDone(s, evt.last_assistant_message);
        // A finished plan, not yet handed on and not being carried out here:
        // the app may start a builder for it. Only a plan saved in a plans
        // folder qualifies; plan mode goes on to carry out its own plan.
        else if (s.plan && !s.plan.sent && !s.plan.build && !s.plan.underway && s.plan.kind === 'folder') {
          this.emit('plan-ready', s.id);
        }
        return null;

      // From the plugin module: one of your model rules chose this subagent's model.
      case 'Routed': {
        const key = evt.tool_use_id || null;
        const a = (key && s.team.find((x) => x.key === key)) || this._teamAdd(s, { key });
        if (typeof evt.model === 'string') a.model = team.shortModel(evt.model);
        a.routed = typeof evt.family === 'string' ? evt.family : true;
        return null;
      }

      // Shown in the team list (team.js), not as steps.
      case 'SubagentStart':
        this._teamStart(s, evt);
        return null;

      case 'SubagentStop':
        this._teamStop(s, evt);
        return null;

      default:
        return null;
    }
  }

  // resp: { type: 'allow' | 'deny' | 'passthrough' } or { type: 'answers', answers: {question: label} }
  answer(pendingId, resp) {
    const w = this.waiters.get(pendingId);
    if (!w || !resp) return false;
    const { pending: p } = w;
    const hso = (body) => ({ hookSpecificOutput: body });
    let out = null;

    if (p.kind === 'permission' && resp.type === 'allow') {
      out = hso({ hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } });
    } else if (p.kind === 'permission' && resp.type === 'always' && p.always) {
      // Allow, and apply exactly the permission updates Claude Code itself suggested.
      out = hso({
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedPermissions: w.suggestions },
      });
    } else if (p.kind === 'permission' && resp.type === 'deny') {
      out = hso({
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'The user denied this from Agent Huddle.' },
      });
      this._markDenied(w);
    } else if (p.kind === 'question' && resp.type === 'answers' && resp.answers && typeof resp.answers === 'object') {
      // AskUserQuestion is answered by allowing it with the answers filled in.
      out = hso({
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: { ...w.input, answers: resp.answers } },
      });
    } else if (resp.type !== 'passthrough') {
      return false;
    }

    this._settle(pendingId, out, out ? 'working' : 'attention');
    return true;
  }

  dismiss(sessionId) {
    if (!this.sessions.has(sessionId)) return;
    this._cancelAll(sessionId);
    this.sessions.delete(sessionId);
    this.dismissed.add(sessionId);
    this._changed();
  }

  // Remove sessions whose Claude Code process is gone without saying goodbye
  // (crashed, killed, or its VS Code window was closed).
  reap(isAlive) {
    for (const s of [...this.sessions.values()]) {
      if (s.pid && !isAlive(s.pid)) this._end(s.id);
    }
  }

  // Bash/PowerShell prompts we hold, for sessions whose Claude Code pid is known.
  shellWaits() {
    const out = [];
    for (const [id, w] of this.waiters) {
      const s = this.sessions.get(w.sessionId);
      if (s?.pid && w.pending.kind === 'permission' && SHELL_TOOLS.has(w.pending.tool)) {
        out.push({ id, sessionId: s.id, pid: s.pid });
      }
    }
    return out;
  }

  // Commands of this session that are running and not waiting on a prompt.
  otherRunningShells(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return 0;
    const running = s.steps.filter((st) => st.status === 'running' && SHELL_TOOLS.has(st.tool)).length;
    const waiting = [...this.waiters.values()].filter(
      (w) => w.sessionId === sessionId && w.pending.kind === 'permission' && SHELL_TOOLS.has(w.pending.tool)
    ).length;
    return Math.max(0, running - waiting);
  }

  // The held command started: it was allowed in the editor. Let the card go.
  releaseStarted(pendingId) {
    this._settle(pendingId, null, 'working');
  }

  // ---- plans: hand one session's plan to another (layer 3) ----

  // Sessions whose plugin module is polling, i.e. that can take a plan.
  canReceive(s) {
    return !!s && Date.now() - s.modSeenAt < MOD_ALIVE_MS;
  }

  // Queue `from`'s plan for `to`; its module submits it as a prompt there.
  sendPlan(fromId, toId) {
    const from = this.sessions.get(fromId);
    const to = this.sessions.get(toId);
    if (!from?.plan || !to || fromId === toId || !this.canReceive(to)) return false;
    this.outbox.set(toId, { text: planPrompt(from), fromId, at: Date.now() });
    from.plan.sent = { to: toId, toName: to.title || to.name, status: 'queued', at: Date.now() };
    this._changed();
    return true;
  }

  // ---- background builders (builder.js; started by the app) ----

  planPromptFor(plannerId) {
    const s = this.sessions.get(plannerId);
    return s?.plan ? planPrompt(s) : null;
  }

  // Builds that are starting or running, everywhere.
  runningBuilds() {
    return [...this.sessions.values()].filter((s) => ['starting', 'running'].includes(s.plan?.build?.status)).length;
  }

  buildStarting(plannerId) {
    const s = this.sessions.get(plannerId);
    if (!s?.plan) return false;
    s.plan.build = { status: 'starting', at: Date.now(), bgId: null, sessionId: null, report: null, reason: '' };
    this._changed();
    return true;
  }

  buildLaunched(plannerId, { bgId, sessionId }) {
    const b = this.sessions.get(plannerId)?.plan?.build;
    if (!b || !['starting', 'running'].includes(b.status)) return;
    Object.assign(b, { status: 'running', bgId: bgId || b.bgId, sessionId: sessionId || b.sessionId });
    if (b.sessionId) {
      this.builders.set(b.sessionId, plannerId);
      const builder = this.sessions.get(b.sessionId);
      if (builder && !builder.builderOf) {
        builder.builderOf = plannerId;
        builder.title = builderName(this.sessions.get(plannerId).plan.title);
      }
      // Linked after the fact: the builder may already be done, or gone.
      if (builder?.state === 'done') {
        const last = [...builder.steps].reverse().find((st) => st.kind === 'message');
        this._builderDone(builder, last?.title || '');
      } else if (!builder && this.dismissed.has(b.sessionId)) {
        b.status = 'stopped';
      }
    }
    this._changed();
  }

  // The builder's first prompt names its plan: link it at once, without
  // waiting for `claude agents` (which only answers a few seconds later).
  _linkByPrompt(s, prompt) {
    if (this.builders.has(s.id) || !isBuilderPrompt(prompt)) return;
    for (const planner of this.sessions.values()) {
      const b = planner.plan?.build;
      if (!b || b.sessionId || !['starting', 'running'].includes(b.status)) continue;
      const p = planner.plan;
      if ((p.path && prompt.includes(p.path)) || (!p.path && p.text && prompt.includes(p.text.slice(0, 200)))) {
        this.buildLaunched(planner.id, { sessionId: s.id });
        return;
      }
    }
  }

  buildFailed(plannerId, reason) {
    const b = this.sessions.get(plannerId)?.plan?.build;
    if (!b) return;
    Object.assign(b, { status: 'failed', reason: clip(reason || 'Could not start', 300) });
    this._changed();
  }

  buildStopped(plannerId) {
    const b = this.sessions.get(plannerId)?.plan?.build;
    if (!b || !['starting', 'running'].includes(b.status)) return;
    b.status = 'stopped';
    this._changed();
  }

  // The builder finished its work: tell its planner, through the planner's module.
  _builderDone(builder, message) {
    const planner = this.sessions.get(this.builders.get(builder.id));
    const b = planner?.plan?.build;
    if (!b || b.status === 'done') return;
    b.status = 'done';
    b.message = clip(message || '', 1500);
    if (this.canReceive(planner)) {
      this.outbox.set(planner.id, { text: reportPrompt(planner.plan.title, message), fromId: builder.id });
      b.report = 'queued';
    } else {
      b.report = 'unavailable'; // the planner has no plugin module: the report is on the builder's card
    }
  }

  // Give up on deliveries nobody is coming for: the receiving session's module
  // stopped asking (the session closed, or a background session finished and
  // exited). Called from the app's 10-second tick.
  expireOutbox() {
    let changed = false;
    for (const [toId, msg] of [...this.outbox]) {
      const to = this.sessions.get(toId);
      if (to && this.canReceive(to)) continue;
      this.outbox.delete(toId);
      for (const s of this.sessions.values()) {
        const sent = s.plan?.sent;
        if (sent && sent.to === toId && s.id === msg.fromId && sent.status === 'queued') {
          sent.status = 'failed';
          changed = true;
        }
        const b = s.plan?.build;
        if (b && s.id === toId && b.report === 'queued') {
          b.report = 'unavailable'; // the report stays on the builder's card
          changed = true;
        }
      }
    }
    if (changed) this._changed();
  }

  // Take back a plan not yet collected.
  cancelPlan(fromId) {
    const from = this.sessions.get(fromId);
    const sent = from?.plan?.sent;
    if (!sent) return;
    const msg = this.outbox.get(sent.to);
    if (msg && msg.fromId === fromId) this.outbox.delete(sent.to);
    from.plan.sent = null;
    this._changed();
  }

  // The module of `session_id` asks for its inbox ('wait' mode: the reply carries it).
  _inbox(evt) {
    const s = this.sessions.get(evt.session_id);
    if (s) {
      const wasAlive = this.canReceive(s);
      s.modSeenAt = Date.now();
      if (!wasAlive) this._changed();
    }
    const msg = this.outbox.get(evt.session_id);
    if (!msg) return null;
    this.outbox.delete(evt.session_id);
    const from = this.sessions.get(msg.fromId);
    if (from?.plan?.sent?.to === evt.session_id) {
      from.plan.sent.status = 'collected';
      this._changed();
    }
    return { promise: Promise.resolve({ huddle: { submit: msg.text, fromId: msg.fromId } }), cancel() {} };
  }

  // The module reports how the submit went: a plan it was sent, or a builder's report.
  _delivered(evt) {
    for (const s of this.sessions.values()) {
      const sent = s.plan?.sent;
      if (sent && sent.to === evt.session_id && s.id === evt.from_id) {
        sent.status = evt.ok === false ? 'failed' : 'delivered';
        sent.at = Date.now();
        this._changed();
      }
      const b = s.plan?.build;
      if (b && s.id === evt.session_id && b.sessionId === evt.from_id) {
        b.report = evt.ok === false ? 'failed' : 'delivered';
        this._changed();
      }
    }
  }

  // After its plan, does this step carry the plan out? A file the main agent
  // changes that is not the plan, or a subagent started to build or fix.
  _carriesOut(s, tool, input, evt) {
    if (FILE_TOOLS.has(tool) && !evt.agent_id) {
      const p = String(input.file_path || '');
      return !!p && p !== s.plan.path && !isPlanFile(p);
    }
    if (AGENT_TOOLS.has(tool) && !evt.agent_id) return team.family(input.description, input.subagent_type) === 'implement';
    return false;
  }

  // kind: 'folder' (a plans folder, as superpowers saves them), 'mode' (plan
  // mode) or 'name' (only the file name says plan). Only a 'folder' plan may
  // start a builder by itself; the others wait for a click (plan mode goes on
  // to carry out its plan in the same session).
  _setPlan(s, { path, text }) {
    const title = path ? planTitle(path) : clip(String(text || '').split('\n').find((l) => l.trim()) || 'plan', 40).replace(/^#+\s*/, '');
    const kind = !path ? 'mode' : /(^|[\\/])plans?[\\/][^\\/]+$/i.test(path) ? 'folder' : 'name';
    s.plan = { path: path || '', text: path ? '' : clip(text, 6000), title, kind, at: Date.now(), sent: null, build: null };
  }

  // Tell a planner (through its module) that a builder took its plan, so it
  // does not start carrying it out as well.
  noticeBuilding(plannerId, name) {
    const s = this.sessions.get(plannerId);
    if (!this.canReceive(s) || this.outbox.has(plannerId)) return false;
    this.outbox.set(plannerId, {
      text: `Agent Huddle started a background session ("${name}") to carry out the plan "${s.plan.title}". Do not carry it out here; its report will come to this session when it is done.`,
      fromId: plannerId,
    });
    return true;
  }

  // Release every waiting hook (app is quitting).
  releaseAll() {
    for (const id of [...this.waiters.keys()]) this._settle(id, null, 'attention');
  }

  // ---- internals ----

  // ---- the team: one entry per subagent ----
  //
  // A subagent is reported by four events that may arrive in any order (the
  // hooks run in the background): the Agent call (PreToolUse: what it is for,
  // keyed by tool_use_id), its result (PostToolUse: agentId, resolvedModel),
  // SubagentStart and SubagentStop (agent_id = agentId). Each event joins the
  // entry the others made, and only makes one when there is none to join.

  _teamAdd(s, fields) {
    const a = {
      key: null, // tool_use_id of the Agent call
      id: null, // agent id
      type: '',
      description: '',
      model: '',
      status: 'running', // 'running' | 'done' | 'failed'
      verdict: null, // 'pass' | 'fail' | 'warn' | null
      summary: '',
      message: '',
      startedAt: Date.now(),
      endedAt: null,
      ...fields,
    };
    // The task it belongs to, for counting rounds of the same step.
    a.task = s.progress && s.progress.done < s.progress.total ? s.progress.label : '';
    this._teamName(s, a);
    s.team.push(a);
    if (s.team.length > MAX_TEAM) s.team.splice(0, s.team.length - MAX_TEAM);
    return a;
  }

  // Label, family and round, from what is known so far.
  _teamName(s, a) {
    a.label = team.label(a.description, a.type);
    a.family = team.family(a.description, a.type);
    a.round =
      a.family === 'other'
        ? 1
        : 1 + s.team.filter((x) => x !== a && x.family === a.family && x.task === a.task && x.startedAt <= a.startedAt).length;
  }

  // The newest running entry still missing `field`, of this type when known.
  _teamUnclaimed(s, field, type) {
    for (let i = s.team.length - 1; i >= 0; i--) {
      const x = s.team[i];
      if (x.status === 'running' && !x[field] && (!type || !x.type || x.type === type)) return x;
    }
    return null;
  }

  _teamCall(s, evt) {
    const input = evt.tool_input || {};
    const key = evt.tool_use_id || null;
    let a = (key && s.team.find((x) => x.key === key)) || this._teamUnclaimed(s, 'key', input.subagent_type);
    if (!a) a = this._teamAdd(s, { key, description: input.description || '', type: input.subagent_type || '' });
    a.key = a.key || key;
    if (!a.description && input.description) {
      a.description = input.description;
      if (!a.type) a.type = input.subagent_type || '';
      this._teamName(s, a);
    }
    if (input.model && !a.model) a.model = team.shortModel(input.model);
  }

  _teamCalled(s, evt, failed) {
    const r = evt.tool_response && typeof evt.tool_response === 'object' ? evt.tool_response : {};
    this._teamCall(s, evt);
    const a = s.team.find((x) => x.key === evt.tool_use_id) || s.team.at(-1);
    if (!a) return;
    if (r.agentId) {
      // SubagentStart/Stop may have made an entry of their own first: fold it in.
      const early = s.team.find((x) => x !== a && x.id === r.agentId);
      if (early) {
        if (early.status !== 'running') Object.assign(a, { status: early.status, verdict: early.verdict, summary: early.summary, message: early.message, endedAt: early.endedAt });
        s.team.splice(s.team.indexOf(early), 1);
      }
      a.id = r.agentId;
    }
    if (r.resolvedModel) a.model = team.shortModel(r.resolvedModel);
    if (failed && a.status === 'running') Object.assign(a, { status: 'failed', verdict: 'fail', endedAt: Date.now() });
  }

  _teamStart(s, evt) {
    const id = evt.agent_id;
    if (!id || s.team.some((x) => x.id === id)) return;
    const a = this._teamUnclaimed(s, 'id', evt.agent_type);
    if (a) {
      a.id = id;
      if (!a.type) a.type = evt.agent_type || '';
    } else this._teamAdd(s, { id, type: evt.agent_type || '' });
  }

  _teamStop(s, evt) {
    const id = evt.agent_id;
    let a = (id && s.team.find((x) => x.id === id)) || this._teamUnclaimed(s, 'id', evt.agent_type);
    if (!a) a = this._teamAdd(s, { id, type: evt.agent_type || '' });
    a.id = a.id || id || null;
    const text = String(evt.last_assistant_message || '');
    Object.assign(a, {
      status: 'done',
      verdict: team.verdict(text),
      summary: team.summary(text),
      message: clip(text, 1500),
      endedAt: Date.now(),
    });
  }

  // A statusLine report. It only updates numbers: it never creates or revives a
  // card, and its parent pid is a shell, not Claude Code, so it is not used to
  // tell whether the session is alive.
  _status(evt) {
    this.usage = mergeUsage(this.usage, evt.rate_limits);
    const s = this.sessions.get(evt.session_id);
    if (s) {
      if (typeof evt.cost_usd === 'number') s.cost = evt.cost_usd;
      if (typeof evt.context_pct === 'number') s.context = evt.context_pct;
    }
    this._changed();
  }

  // The session is over. Events for it that are still in flight (hooks run in
  // the background and can land late) must not bring its card back.
  _end(id) {
    this._cancelAll(id);
    // A builder that ends before it finished: its planner's card says so.
    const plannerId = this.builders.get(id);
    if (plannerId) this.buildStopped(plannerId);
    // Forget the links and deliveries of a session that is gone.
    this.builders.delete(id);
    for (const [builderId, pid] of [...this.builders]) if (pid === id) this.builders.delete(builderId);
    this.outbox.delete(id);
    if (this.dismissed.size > 500) this.dismissed.clear();
    this.dismissed.add(id);
    if (this.sessions.delete(id)) this._changed();
  }

  // Trust the reported parent pid only once two events agree on it; if they
  // ever disagree it is not the session's own process, so stop using it.
  _seenPid(s, pid) {
    if (!pid || s.pidUnreliable) return;
    if (s.pidCandidate === pid) s.pid = pid;
    else if (s.pidCandidate) {
      s.pid = null;
      s.pidUnreliable = true;
    } else s.pidCandidate = pid;
  }

  _session(evt) {
    let s = this.sessions.get(evt.session_id);
    if (!s) {
      const cwd = evt.cwd || '';
      s = {
        id: evt.session_id,
        cwd,
        name: base(cwd) || 'agent',
        title: '',
        hue: hue(evt.session_id),
        state: 'idle',
        note: '',
        steps: [],
        pending: [],
        tasks: [],
        progress: null, // { done, total, label } when the agent keeps a task list
        team: [], // subagents of the current piece of work, see team.js
        plan: null, // { path?, text?, title, at, sent?: { to, toName, status, at } }
        modSeenAt: 0, // last time this session's plugin module asked for its inbox
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.sessions.set(s.id, s);
    }
    return s;
  }

  // Task-list tools (TaskCreate / TaskUpdate) feed the progress bar.
  _trackTask(s, tool, input, response) {
    if (tool === 'TaskCreate') {
      const r = response && typeof response === 'object' ? response : {};
      const id = r.task?.id ?? r.id ?? r.taskId ?? `local-${s.tasks.length + 1}`;
      s.tasks.push({
        id: String(id),
        subject: clip(input.subject, 80),
        activeForm: clip(input.activeForm, 80),
        status: 'pending',
      });
    } else if (tool === 'TaskUpdate') {
      const i = s.tasks.findIndex((t) => t.id === String(input.taskId));
      if (i < 0) return;
      if (input.status === 'deleted') s.tasks.splice(i, 1);
      else {
        const t = s.tasks[i];
        if (input.status) t.status = input.status;
        if (input.subject) t.subject = clip(input.subject, 80);
        if (input.activeForm) t.activeForm = clip(input.activeForm, 80);
      }
    } else {
      return;
    }
    s.progress = progress(s.tasks);
  }

  _step(s, step) {
    step.id = ++this.seq;
    step.at = Date.now();
    s.steps.push(step);
    if (s.steps.length > MAX_STEPS) s.steps.splice(0, s.steps.length - MAX_STEPS);
    return step;
  }

  // The same agent is starting a different tool while we still hold one of its
  // prompts: it was answered (most likely denied) somewhere else. The age check
  // keeps tool calls issued in the same breath from releasing each other.
  _movedOn(s, evt) {
    const sig = signature(evt.tool_name, evt.tool_input || {});
    const agentId = evt.agent_id || '';
    for (const [id, w] of [...this.waiters]) {
      if (w.sessionId !== s.id || w.agentId !== agentId || w.sig === sig) continue;
      if (Date.now() - w.at > MOVED_ON_MS) this._settle(id, null, 'working');
    }
  }

  _pend(s, pending, input, agentId, suggestions) {
    pending.id = ++this.seq;
    s.pending.push(pending);
    s.state = s.pending[0].kind;
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    this.waiters.set(pending.id, {
      sessionId: s.id,
      pending,
      input,
      resolve,
      sig: signature(pending.tool, input),
      agentId: agentId || '',
      suggestions,
      at: Date.now(),
    });
    // The hook process went away: answered elsewhere, or timed out.
    const cancel = () => this._settle(pending.id, null, 'working');
    return { promise, cancel };
  }

  _settle(pendingId, out, nextState) {
    const w = this.waiters.get(pendingId);
    if (!w) return;
    this.waiters.delete(pendingId);
    const s = this.sessions.get(w.sessionId);
    if (s) {
      s.pending = s.pending.filter((p) => p.id !== pendingId);
      if (s.pending.length) s.state = s.pending[0].kind;
      else if (s.state === 'permission' || s.state === 'question') {
        s.state = nextState;
        const p = w.pending;
        s.note = nextState !== 'attention' ? '' : p.kind === 'question' ? 'Has a question for you' : `Wants to: ${p.title || p.tool}`;
      }
    }
    w.resolve(out);
    this._changed();
  }

  _cancelAll(sessionId) {
    for (const [id, w] of [...this.waiters]) {
      if (w.sessionId === sessionId) this._settle(id, null, 'working');
    }
  }

  _markDenied(w) {
    const s = this.sessions.get(w.sessionId);
    if (!s) return;
    const d = describe(w.pending.tool, w.input);
    for (let i = s.steps.length - 1; i >= 0; i--) {
      const st = s.steps[i];
      if (st.status === 'running' && st.tool === w.pending.tool && st.detail === d.detail) {
        st.status = 'denied';
        return;
      }
    }
  }

  _changed() {
    this.emit('change');
  }
}

// '<task-notification>…<summary>Agent "x" finished</summary>…' -> a short line, or null
// for a prompt the user really wrote.
function systemNotice(prompt) {
  const p = String(prompt || '').trim();
  const m = /^<task-notification>/i.exec(p);
  if (!m) return null;
  const tag = (name) => {
    const r = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(p);
    return r ? r[1].trim() : '';
  };
  const summary = tag('summary');
  const status = tag('status');
  if (summary) return clip(`Background task: ${summary}`, 200);
  return status ? `Background task ${status}` : 'Background task update';
}

// What the receiving session is asked. Worded so that a session with
// superpowers picks up its plan-execution skills by itself.
function planPrompt(from) {
  const who = from.title || from.name;
  const p = from.plan;
  if (p.path) {
    return `Here is an implementation plan written in another session (${who}): ${p.path}\n\nRead it and carry it out task by task, checking your work as you go.`;
  }
  return `Here is an implementation plan written in another session (${who}):\n\n${p.text}\n\nCarry it out task by task, checking your work as you go.`;
}

function signature(tool, input) {
  try {
    return `${tool}:${JSON.stringify(input)}`;
  } catch {
    return String(tool);
  }
}

function progress(tasks) {
  if (!tasks.length) return null;
  const done = tasks.filter((t) => t.status === 'completed').length;
  const active = tasks.find((t) => t.status === 'in_progress');
  const next = tasks.find((t) => t.status !== 'completed');
  const label = active ? active.activeForm || active.subject : next ? next.subject : 'All tasks done';
  return { done, total: tasks.length, label };
}

function hue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

module.exports = { Store };
