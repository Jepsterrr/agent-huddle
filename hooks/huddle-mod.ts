// The 'claude-code' types are written by Claude Code itself when it loads a
// plugin module; an editor opening this repository does not have them, so it
// may show type errors here. Check the module with `claude plugin validate .`
import type { EngineInterface, Register } from 'claude-code'

// Agent Huddle's plugin module. Two small jobs, both local:
//
// 1. Quota and cost. Claude Code hands a plugin module the figures it gives a
//    statusLine command (`session.measure`, after each turn and when a quota
//    window moves a point). They go to the app on 127.0.0.1 with its token,
//    as the same fields `hook.js status` sends, so the plugin needs no
//    statusLine in the user's settings.
//
// 2. Subagent models (off unless turned on in Huddle's Settings). When an
//    agent starts one of Claude Code's built-in subagents (general-purpose,
//    Explore, Plan) WITHOUT choosing a model, the role's rule from
//    ~/.agent-huddle/routing.json sets one. The agent's own choice always
//    wins, custom and plugin agents keep the model their definition gives,
//    forks are left alone, and anything that goes wrong runs the subagent
//    exactly as it was asked for.
//
// 3. Plans between sessions. Every few seconds the module asks the app whether
//    you sent this session a plan from another session's card. If so it
//    submits it here as a prompt (marked as coming from this plugin), and
//    reports back so the sending card can say it arrived. Nothing is ever
//    submitted that you did not send from the huddle yourself.
//
// When the app is not running there is no runtime file and nothing is sent.

type Window = { used_percentage: number; resets_at?: number }
type Runtime = { port: number; token: string }
type Family = { name: string; pattern: string; model: string | null }
type Routing = { enabled: boolean; families: Family[] }

const MODELS = ['sonnet', 'opus', 'haiku', 'fable'] as const
// Built-in subagent types whose model comes from no definition of their own
// (forks always inherit the parent's model, so they are not here).
const BUILTIN_AGENTS: readonly string[] = ['general-purpose', 'Explore', 'Plan']
type Model = (typeof MODELS)[number]

function isModel(m: unknown): m is Model {
  return typeof m === 'string' && (MODELS as readonly string[]).includes(m)
}

// Huddle's folder: HUDDLE_HOME, else ~/.agent-huddle.
async function huddleHome($: EngineInterface): Promise<string> {
  return (
    (await $.env.get('HUDDLE_HOME')) ??
    `${(await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''}/.agent-huddle`
  )
}

// Posts one event to the running app. Rejects when the app is not running.
async function sendToHuddle($: EngineInterface, body: object): Promise<void> {
  const runtime = JSON.parse(await $.fs.read(`${await huddleHome($)}/runtime.json`)) as Runtime
  await $.http.fetch(`http://127.0.0.1:${runtime.port}/event`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-huddle-token': runtime.token,
      'x-huddle-mode': 'notify',
    },
    body: JSON.stringify({ session_id: await $.session.id(), ...body }),
  })
}

const INBOX_EVERY_MS = 3000
let collecting = false // one inbox check at a time

// Collects a plan sent to this session from the huddle, and submits it.
async function collectInbox($: EngineInterface): Promise<void> {
  if (collecting) return
  collecting = true
  try {
    const runtime = JSON.parse(await $.fs.read(`${await huddleHome($)}/runtime.json`)) as Runtime
    const res = await $.http.fetch(`http://127.0.0.1:${runtime.port}/event`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-huddle-token': runtime.token,
        'x-huddle-mode': 'wait', // the reply carries what is waiting, if anything
      },
      body: JSON.stringify({ session_id: await $.session.id(), hook_event_name: 'Inbox' }),
    })
    if (res.status !== 200) return // 204: nothing waiting
    const msg = (JSON.parse(res.text) as { huddle?: { submit?: string; fromId?: string } }).huddle
    if (!msg?.submit) return
    let ok = true
    try {
      await $.prompt.submit({ text: msg.submit })
    } catch {
      ok = false
    }
    await sendToHuddle($, { hook_event_name: 'Delivered', from_id: msg.fromId, ok })
  } finally {
    collecting = false
  }
}

// The rules, or null when there are none to apply.
async function readRouting($: EngineInterface): Promise<Routing | null> {
  try {
    const routing = JSON.parse(await $.fs.read(`${await huddleHome($)}/routing.json`)) as Routing
    return routing?.enabled && Array.isArray(routing.families) ? routing : null
  } catch {
    return null
  }
}

export const register: Register = on => {
  // ---- 1. quota and cost ----

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    try {
      const windows: Record<string, Window> = {}
      for (const w of e.rateLimits) {
        const at = w.resetsAt ? Date.parse(w.resetsAt) / 1000 : NaN
        windows[w.kind] = { used_percentage: w.percentUsed, resets_at: Number.isFinite(at) ? at : undefined }
      }
      await sendToHuddle($, {
        hook_event_name: 'StatusLine',
        source: 'mod',
        cost_usd: e.cost?.usd,
        context_pct: e.context.percent,
        rate_limits: e.rateLimits.length ? windows : undefined,
      })
    } catch {
      // The app is not running, or not reachable: Huddle is never in the way.
    }
    return result
  })

  // ---- 3. plans between sessions: check the inbox while the session lives ----

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    $.clock.every(INBOX_EVERY_MS, () => {
      collectInbox($).catch(() => {}) // the app is not running: try again later
    })
    return result
  })

  // ---- 2. subagent models ----

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.model) return next(e) // the agent chose: leave it
    // Only Claude Code's built-in subagents. A custom or plugin agent may set
    // its model in its definition, and a model here would override that.
    if (e.subagent_type && !BUILTIN_AGENTS.includes(e.subagent_type)) return next(e)
    const routing = await readRouting($)
    if (!routing) return next(e)

    const text = `${e.description ?? ''} ${e.subagent_type ?? ''}`
    const family = routing.families.find(f => new RegExp(f.pattern, 'i').test(text))
    if (!family || !isModel(family.model)) return next(e)

    // Tell the huddle a rule chose this model, for the team view. Best effort.
    sendToHuddle($, { hook_event_name: 'Routed', tool_use_id: e.tool_use_id, family: family.name, model: family.model }).catch(() => {})
    return next({ ...e, model: family.model })
  }).catch(($, e, next) => next(e)) // a rule that fails changes nothing
}
