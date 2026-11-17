// Account quota windows, merged from the statusLine reports of every session.
//
// Claude Code puts `rate_limits` in the statusLine input for claude.ai Pro, Max
// and Ultra (and gateways with a spend limit), after the session's first API
// response. Each window has used_percentage (0-100) and resets_at (Unix s).
// The numbers are account-wide, so sessions report the same windows; a session
// that has been quiet for a while reports an older, lower number.

const WINDOWS = ['five_hour', 'seven_day', 'spend_limit'];
const SAME_WINDOW_S = 120; // resets_at may differ slightly between reports

// usage: { five_hour?: { pct, resetsAt }, seven_day?: …, spend_limit?: { pct, resetsAt, usedUsd, limitUsd, period } }
function mergeUsage(usage, rateLimits, nowS = Date.now() / 1000) {
  const out = pruneUsage(usage, nowS);
  if (!rateLimits || typeof rateLimits !== 'object') return out;
  for (const key of WINDOWS) {
    const w = rateLimits[key];
    if (!w || typeof w.used_percentage !== 'number' || !Number.isFinite(w.used_percentage)) continue;
    const resetsAt = typeof w.resets_at === 'number' ? w.resets_at : null;
    if (resetsAt != null && resetsAt <= nowS) continue;
    const next = { pct: Math.max(0, w.used_percentage), resetsAt };
    if (key === 'spend_limit') Object.assign(next, { usedUsd: w.used_usd, limitUsd: w.limit_usd, period: w.period });
    const cur = out[key];
    if (!cur || resetsAt == null || cur.resetsAt == null) out[key] = next;
    else if (resetsAt > cur.resetsAt + SAME_WINDOW_S) out[key] = next; // a new window began
    else if (Math.abs(resetsAt - cur.resetsAt) <= SAME_WINDOW_S) {
      out[key] = next.pct >= cur.pct ? next : cur; // same window: the higher (newer) number wins
    } // else: a stale report from an older window, ignore
  }
  return out;
}

// Drop windows whose reset time has passed.
function pruneUsage(usage, nowS = Date.now() / 1000) {
  const out = {};
  for (const key of WINDOWS) {
    const w = usage && usage[key];
    if (w && (w.resetsAt == null || w.resetsAt > nowS)) out[key] = w;
  }
  return out;
}

// Highest percentage across the windows that cap usage (five_hour, seven_day, spend_limit).
function peakPct(usage) {
  let max = null;
  for (const key of WINDOWS) {
    const w = usage && usage[key];
    if (w && typeof w.pct === 'number') max = Math.max(max ?? 0, w.pct);
  }
  return max;
}

module.exports = { mergeUsage, pruneUsage, peakPct };
