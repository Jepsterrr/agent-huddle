const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { huddleHooks, isHuddleHookPath, isHuddleStatus, settingsHaveHuddleHooks } = require('../hooks/shared');
const { startServer } = require('../src/server');
const { Store } = require('../src/store');

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// A copy of the hook scripts with no node_modules next to them: what a plugin
// install looks like before /agent-huddle:setup has downloaded Electron.
function bareHookCopy() {
  const dir = tmp('huddle plugin ');
  fs.mkdirSync(path.join(dir, 'hooks'));
  for (const f of ['hook.js', 'shared.js']) fs.copyFileSync(path.join(ROOT, 'hooks', f), path.join(dir, 'hooks', f));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agent-huddle' }));
  return path.join(dir, 'hooks', 'hook.js');
}

function run(hook, args, payload, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hook, ...args], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('the plugin manifest, marketplace and hooks agree with install-hooks', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  const market = readJson('.claude-plugin/marketplace.json');
  assert.equal(plugin.name, 'agent-huddle');
  assert.equal(plugin.version, readJson('package.json').version);
  assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [['agent-huddle', './']]);
  // hooks/hooks.json is generated from the same definition install-hooks uses.
  const hooks = readJson('hooks/hooks.json');
  assert.deepEqual(hooks.hooks, huddleHooks('node', '${CLAUDE_PLUGIN_ROOT}/hooks/hook.js', ['--plugin']));
  // Exec form everywhere: command + args, no shell.
  for (const groups of Object.values(hooks.hooks)) for (const h of groups.flatMap((g) => g.hooks)) assert.ok(Array.isArray(h.args));
  // Electron is a runtime dependency, so the plugin's automatic install includes it.
  assert.ok(readJson('package.json').dependencies.electron);
  // The quota comes through the plugin's own module, not a statusLine.
  assert.deepEqual(hooks.modules, ['./huddle-mod.ts']);
  assert.ok(fs.existsSync(path.join(ROOT, 'hooks', 'huddle-mod.ts')));
});

test('the plugin module sends what the statusLine bridge sends, to 127.0.0.1 only', () => {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'huddle-mod.ts'), 'utf8');
  assert.match(src, /on\('session\.measure'/);
  // Same event name, mode and fields as hook.js's statusBody().
  for (const field of ["hook_event_name: 'StatusLine'", 'session_id:', 'cost_usd:', 'context_pct:', 'rate_limits:', 'used_percentage', 'resets_at']) {
    assert.ok(src.includes(field), `huddle-mod.ts lacks ${field}`);
  }
  // Sent as plain events; the store knows StatusLine by its name, whatever the mode.
  assert.ok(src.includes("'x-huddle-mode': 'notify'") && src.includes("'x-huddle-token': runtime.token"));
  // The only address it talks to.
  const urls = src.match(/https?:\/\/[^`'"]+/g) || [];
  assert.deepEqual([...new Set(urls)], ['http://127.0.0.1:${runtime.port}/event']);
  // It never writes anything.
  assert.ok(!/\$\.fs\.write|\$\.env\.set|\$\.process/.test(src));
});

test('Huddle hooks are recognised in any folder name, nothing else is', () => {
  assert.equal(isHuddleHookPath('C:\\Users\\x\\agent-huddle\\hooks\\hook.js'), true); // older installs
  assert.equal(isHuddleHookPath(path.join(ROOT, 'hooks', 'hook.js')), true);
  const renamed = bareHookCopy(); // "huddle plugin xyz/hooks/hook.js" with our package.json
  assert.equal(isHuddleHookPath(renamed), true);
  assert.equal(isHuddleHookPath('C:\\other\\project\\hooks\\hook.js'), false);
  assert.equal(isHuddleStatus({ command: `node "${renamed.replace(/\\/g, '/')}" status` }), true);
  assert.equal(isHuddleStatus({ command: 'node "C:/other/hooks/hook.js" status' }), false);
  assert.equal(isHuddleStatus({ command: 'bash ~/.claude/mine.sh' }), false);
});

test('the plugin steps aside when install-hooks already registered Huddle', async () => {
  const store = new Store();
  const seen = [];
  const server = await startServer({ token: 't', onEvent: (p, m) => (seen.push(p.hook_event_name), store.handle(p, m)) });
  const home = tmp('huddle-');
  fs.writeFileSync(path.join(home, 'runtime.json'), JSON.stringify({ port: server.address().port, token: 't' }));
  const settings = path.join(home, 'settings.json');
  const env = { HUDDLE_HOME: home, HUDDLE_SETTINGS_FILE: settings, HUDDLE_NO_AUTOSTART: '1' };
  const hook = path.join(ROOT, 'hooks', 'hook.js');
  const evt = { session_id: 's', cwd: 'C:\\x', hook_event_name: 'UserPromptSubmit', prompt: 'hi' };
  try {
    // Installed through install-hooks too: the plugin's copy sends nothing.
    fs.writeFileSync(settings, JSON.stringify({ hooks: huddleHooks(process.execPath, hook) }));
    assert.equal(settingsHaveHuddleHooks(JSON.parse(fs.readFileSync(settings, 'utf8'))), true);
    assert.deepEqual(await run(hook, ['--plugin'], evt, env), { code: 0, out: '' });
    assert.deepEqual(seen, []);
    // install-hooks's own copy still reports.
    await run(hook, [], evt, env);
    assert.deepEqual(seen, ['UserPromptSubmit']);
    // Plugin only: it reports.
    fs.writeFileSync(settings, JSON.stringify({ hooks: {} }));
    await run(hook, ['--plugin'], evt, env);
    assert.deepEqual(seen, ['UserPromptSubmit', 'UserPromptSubmit']);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('before setup: the plugin says so once a day and never downloads', async () => {
  const hook = bareHookCopy();
  const home = tmp('huddle-');
  const data = tmp('huddle data ');
  const env = { HUDDLE_HOME: home, HUDDLE_SETTINGS_FILE: path.join(home, 'none.json'), CLAUDE_PLUGIN_DATA: data };
  const start = { session_id: 's', cwd: 'C:\\x', hook_event_name: 'SessionStart' };

  const t = Date.now();
  const first = await run(hook, ['--plugin'], start, env);
  assert.ok(Date.now() - t < 3000, 'the hook must return at once (no Electron download)');
  assert.equal(first.code, 0);
  assert.match(JSON.parse(first.out).systemMessage, /\/agent-huddle:setup/);

  assert.deepEqual(await run(hook, ['--plugin'], start, env), { code: 0, out: '' }); // not again today
  // Other events and non-plugin runs never print it.
  fs.rmSync(path.join(data, 'setup-notice.json'));
  assert.deepEqual(await run(hook, [], start, env), { code: 0, out: '' });
  assert.deepEqual(await run(hook, ['--plugin'], { ...start, hook_event_name: 'Stop' }, env), { code: 0, out: '' });
});

test('setup refuses to run without its data folder', () => {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup.js')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\/agent-huddle:setup/);
  const r2 = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup.js'), '--data', '${CLAUDE_PLUGIN_DATA}'], { encoding: 'utf8' });
  assert.equal(r2.status, 1); // an unexpanded variable is not a folder
});

