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
        // Claude Code hands some events to the model as if the user typed them
        // (a background task finishing). Show those as what they are, not as "You".
        const note = systemNotice(evt.prompt);
        if (note) this._step(s, { kind: 'agent', title: note });
        else this._step(s, { kind: 'prompt', title: clip(evt.prompt, 600) });
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
        return null;

      case 'SubagentStart':
        this._step(s, { kind: 'agent', title: `Subagent started: ${evt.agent_type || 'agent'}` });
        return null;

      case 'SubagentStop':
        this._step(s, { kind: 'agent', title: `Subagent finished: ${evt.agent_type || 'agent'}` });
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

  // Release every waiting hook (app is quitting).
  releaseAll() {
    for (const id of [...this.waiters.keys()]) this._settle(id, null, 'attention');
  }

  // ---- internals ----

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
