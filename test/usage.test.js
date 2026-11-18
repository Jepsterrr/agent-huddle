const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { mergeUsage, pruneUsage, peakPct } = require('../src/usage');
const { Store } = require('../src/store');

const NOW = 1_800_000_000;
const rl = (five, sevenPct, fiveReset = NOW + 3600) => ({
  five_hour: { used_percentage: five, resets_at: fiveReset },
  seven_day: sevenPct == null ? undefined : { used_percentage: sevenPct, resets_at: NOW + 86400 },
});

test('windows from several sessions merge: same window keeps the highest number', () => {
  let u = mergeUsage({}, rl(40, 10), NOW);
  u = mergeUsage(u, rl(35, 9), NOW); // a quieter session with an older reading
  assert.equal(u.five_hour.pct, 40);
  assert.equal(u.seven_day.pct, 10);
  u = mergeUsage(u, rl(55, 12), NOW);
  assert.equal(u.five_hour.pct, 55);
  assert.equal(peakPct(u), 55);
});

test('a new window replaces the old one; a stale one is ignored; passed resets drop out', () => {
  let u = mergeUsage({}, rl(90, null), NOW);
  u = mergeUsage(u, rl(5, null, NOW + 5 * 3600), NOW); // the 5 h window rolled over
  assert.equal(u.five_hour.pct, 5);
  u = mergeUsage(u, rl(95, null), NOW); // a late report from the previous window
  assert.equal(u.five_hour.pct, 5);
  assert.deepEqual(pruneUsage(u, NOW + 6 * 3600), {});
  assert.equal(peakPct({}), null);
});

test('missing or junk rate_limits change nothing', () => {
  const u = mergeUsage({}, rl(20, 30), NOW);
  assert.deepEqual(mergeUsage(u, undefined, NOW), u);
  assert.deepEqual(mergeUsage(u, { five_hour: { used_percentage: 'x' } }, NOW), u);
});

test('StatusLine updates numbers only: no new card, no revive, no pid', () => {
  const store = new Store();
  const status = (extra) => ({ hook_event_name: 'StatusLine', session_id: 's1', ...extra });
  store.handle(status({ cost_usd: 1.5, rate_limits: rl(30, 10, Date.now() / 1000 + 3600) }), 'status', { ppid: 999 });
  assert.equal(store.snapshot().length, 0);
  assert.equal(Math.round(store.usageNow().five_hour.pct), 30);

  store.handle({ session_id: 's1', cwd: 'C:\\x', hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, 'notify', { ppid: 5 });
  store.handle(status({ cost_usd: 2.25, context_pct: 40 }), 'status', { ppid: 999 });
  store.handle({ session_id: 's1', hook_event_name: 'Stop' }, 'notify', { ppid: 5 });
  const [s] = store.snapshot();
  assert.equal(s.cost, 2.25);
  assert.equal(s.context, 40);
  assert.equal(s.pid, 5); // the status line's shell pid did not spoil it
  assert.ok(!s.pidUnreliable);

  store.dismiss('s1');
  store.handle(status({ cost_usd: 3 }), 'status');
  assert.equal(store.snapshot().length, 0);

  // The plugin module sends it as a plain event: the same handling, by name.
  store.handle(status({ cost_usd: 4 }), 'notify', { ppid: 999 });
  assert.equal(store.snapshot().length, 0);
});

// ---- the hook script in status mode ----

const HOOK = path.resolve(__dirname, '..', 'hooks', 'hook.js');

test('hook status mode: silent and exit 0 without the app, and on junk input', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-'));
  const env = { ...process.env, HUDDLE_HOME: home, HUDDLE_NO_AUTOSTART: '1' };
  for (const input of [JSON.stringify({ session_id: 'x', rate_limits: rl(1, 1) }), 'not json', '']) {
    const r = spawnSync(process.execPath, [HOOK, 'status'], { input, env, timeout: 5000 });
    assert.equal(r.status, 0);
    assert.equal(String(r.stdout), '');
  }
});

test('hook status mode forwards only the numbers', async () => {
  const { startServer } = require('../src/server');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-'));
  let got;
  const server = await startServer({ token: 't', onEvent: (p, mode) => ((got = { p, mode }), null) });
  fs.writeFileSync(path.join(home, 'runtime.json'), JSON.stringify({ port: server.address().port, token: 't' }));
  try {
    const input = JSON.stringify({
      session_id: 's9',
      cwd: 'C:\\secret\\project',
      transcript_path: 'C:\\x.jsonl',
      model: { display_name: 'Opus' },
      cost: { total_cost_usd: 0.42 },
      context_window: { used_percentage: 12 },
      rate_limits: { five_hour: { used_percentage: 33, resets_at: 1 } },
    });
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [HOOK, 'status'], { env: { ...process.env, HUDDLE_HOME: home } });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stdin.end(input);
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 0);
    assert.equal(out, '');
    assert.equal(got.mode, 'status');
    assert.deepEqual(Object.keys(got.p).sort(), ['context_pct', 'cost_usd', 'hook_event_name', 'rate_limits', 'session_id']);
    assert.equal(got.p.cost_usd, 0.42);
    assert.equal(got.p.rate_limits.five_hour.used_percentage, 33);
    assert.ok(!JSON.stringify(got.p).includes('secret'));
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
