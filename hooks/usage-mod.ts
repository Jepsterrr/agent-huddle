import type { Register } from 'claude-code'

// The plugin's quota bridge. Claude Code hands a plugin module the same
// figures it gives a statusLine command (`session.measure`, after each turn
// and when a quota window moves a point), so the plugin gets the 5-hour and
// weekly quota, cost and context without a statusLine in the user's settings.
// It sends the same fields as `hook.js status`, to the app on 127.0.0.1 with
// the app's token. When the app is not running there is no runtime file and
// nothing happens.

type Window = { used_percentage: number; resets_at?: number }

export const register: Register = on => {
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    try {
      const home =
        (await $.env.get('HUDDLE_HOME')) ??
        `${(await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''}/.agent-huddle`
      const runtime = JSON.parse(await $.fs.read(`${home}/runtime.json`)) as { port: number; token: string }

      const windows: Record<string, Window> = {}
      for (const w of e.rateLimits) {
        const at = w.resetsAt ? Date.parse(w.resetsAt) / 1000 : NaN
        windows[w.kind] = { used_percentage: w.percentUsed, resets_at: Number.isFinite(at) ? at : undefined }
      }

      await $.http.fetch(`http://127.0.0.1:${runtime.port}/event`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-huddle-token': runtime.token,
          'x-huddle-mode': 'status',
        },
        body: JSON.stringify({
          hook_event_name: 'StatusLine',
          source: 'mod',
          session_id: await $.session.id(),
          cost_usd: e.cost?.usd,
          context_pct: e.context.percent,
          rate_limits: e.rateLimits.length ? windows : undefined,
        }),
      })
    } catch {
      // The app is not running, or not reachable: Huddle is never in the way.
    }
    return result
  })
}
