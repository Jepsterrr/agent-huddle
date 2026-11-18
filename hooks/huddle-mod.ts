// The 'claude-code' types are written by Claude Code itself when it loads a
// plugin module; an editor opening this repository does not have them, so it
// may show type errors here. Check the module with `claude plugin validate .`
import type { EngineInterface, Register } from 'claude-code'
import { chooseModel, inboxMessage, parseRouting, parseRuntime, statusEvent } from './mod-logic.mjs'
import type { Runtime } from './mod-logic.mjs'

// Agent Huddle's plugin module. Three small jobs, all local:
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
// What each job decides is in mod-logic.mjs (tested in test/mod.test.js);
// this file only reads, fetches and submits. When the app is not running
// there is no runtime file and nothing is sent.

// Huddle's folder: HUDDLE_HOME, else ~/.agent-huddle.
async function huddleHome($: EngineInterface): Promise<string> {
  return (
    (await $.env.get('HUDDLE_HOME')) ??
    `${(await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''}/.agent-huddle`
  )
}

// The running app's port and token. Rejects when the app is not running.
async function readRuntime($: EngineInterface): Promise<Runtime> {
  const runtime = parseRuntime(await $.fs.read(`${await huddleHome($)}/runtime.json`))
  if (!runtime) throw new Error('no usable runtime.json')
  return runtime
}

// Posts one event to the running app. Rejects when the app is not running.
async function postEvent($: EngineInterface, mode: 'notify' | 'wait', body: object) {
  const runtime = await readRuntime($)
  return $.http.fetch(`http://127.0.0.1:${runtime.port}/event`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-huddle-token': runtime.token,
      'x-huddle-mode': mode, // 'wait': the reply carries what is waiting, if anything
    },
    body: JSON.stringify({ session_id: await $.session.id(), ...body }),
  })
}

const INBOX_EVERY_MS = 3000
let collecting = false // one inbox check at a time
let inboxTimer: { cancel: () => void } | undefined

// Collects a plan sent to this session from the huddle, and submits it.
async function collectInbox($: EngineInterface): Promise<void> {
  if (collecting) return
  collecting = true
  try {
    const res = await postEvent($, 'wait', { hook_event_name: 'Inbox' })
    const msg = inboxMessage(res.status, res.text)
    if (!msg) return
    let ok = true
    try {
      await $.prompt.submit({ text: msg.submit })
    } catch {
      ok = false
    }
    await postEvent($, 'notify', { hook_event_name: 'Delivered', from_id: msg.fromId, ok })
  } finally {
    collecting = false
  }
}

export const register: Register = on => {
  // ---- 1. quota and cost ----

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    try {
      await postEvent($, 'notify', statusEvent(e))
    } catch {
      // The app is not running, or not reachable: Huddle is never in the way.
    }
    return result
  })

  // ---- 3. plans between sessions: check the inbox while the session lives ----
  //
  // session.start fires once per session (a /clear keeps the process and its
  // timer, under a new session id), and a module reload cancels the timer
  // itself. The old timer is still cancelled first, so there is never more
  // than one, whatever the engine does.

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    inboxTimer?.cancel()
    inboxTimer = $.clock.every(INBOX_EVERY_MS, () => {
      collectInbox($).catch(() => {}) // the app is not running: try again later
    })
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') {
      inboxTimer?.cancel()
      inboxTimer = undefined
    }
    return next(e)
  })

  // ---- 2. subagent models ----

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.model) return next(e) // the agent chose: leave it (before any file is read)
    let routing = null
    try {
      routing = parseRouting(await $.fs.read(`${await huddleHome($)}/routing.json`))
    } catch {
      // no rules file: nothing to apply
    }
    const choice = chooseModel(routing, e)
    if (!choice) return next(e)

    // Tell the huddle a rule chose this model, for the team view. Best effort.
    postEvent($, 'notify', { hook_event_name: 'Routed', tool_use_id: e.tool_use_id, ...choice }).catch(() => {})
    return next({ ...e, model: choice.model })
  }).catch(($, e, next) => next(e)) // a rule that fails changes nothing
}
