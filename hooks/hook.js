#!/usr/bin/env node
// Claude Code hook -> Agent Huddle bridge.
//
// Reads the hook payload from stdin and forwards it to the running Huddle app.
// Whatever the app answers is printed to stdout as the hook's decision.
//
// It must never get in Claude Code's way: if the app is not running, or
// anything at all goes wrong, it exits 0 with no output, which Claude Code
// treats as "no decision" (the normal prompt is shown).
//
// The one thing it does beyond forwarding: when a session starts and the app
// is not running, it launches the app.
//
//   node hook.js          fire-and-forget event, gives up after 1.5 s
//   node hook.js wait     waits for the user to answer in the Huddle
//   node hook.js status   statusLine bridge: forwards usage and quota numbers,
//                         prints nothing, never starts the app, gives up after 0.8 s
//
// The Claude Code plugin adds --plugin. Then it steps aside when install-hooks
// has put Huddle's hooks in settings.json too, so nothing is sent twice.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const fromPlugin = argv.includes('--plugin');
const mode = ['wait', 'status'].includes(argv[0]) ? argv[0] : 'notify';
const pluginData = process.env.CLAUDE_PLUGIN_DATA || '';
const wait = mode === 'wait';
const home = process.env.HUDDLE_HOME || path.join(os.homedir(), '.agent-huddle');

const quit = () => process.exit(0);
process.on('uncaughtException', quit);

if (!wait) setTimeout(quit, mode === 'status' ? 800 : 1500).unref();

// From the statusLine payload, keep only the numbers the huddle shows. Paths,
// model, workspace and the rest stay here.
function statusBody(raw) {
  const j = JSON.parse(raw.toString('utf8'));
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const win = (w) =>
    w && typeof w === 'object'
      ? {
          used_percentage: num(w.used_percentage),
          resets_at: num(w.resets_at),
          used_usd: num(w.used_usd),
          limit_usd: num(w.limit_usd),
          period: typeof w.period === 'string' ? w.period : undefined,
        }
      : undefined;
  const rl = j.rate_limits || {};
  return Buffer.from(
    JSON.stringify({
      hook_event_name: 'StatusLine',
      session_id: j.session_id,
      cost_usd: num(j.cost?.total_cost_usd),
      context_pct: num(j.context_window?.used_percentage),
      rate_limits: j.rate_limits
        ? { five_hour: win(rl.five_hour), seven_day: win(rl.seven_day), spend_limit: win(rl.spend_limit) }
        : undefined,
    })
  );
}

// The Electron binary, or null. Looked up by hand: require('electron') would
// start a ~100 MB download, synchronously, when the binary is missing, and a
// hook must never do that. Checks the app's own node_modules (a clone with
// `npm install`), then the copy `/agent-huddle:setup` puts in the plugin's
// data folder (it survives plugin updates).
function electronBinary(appDir) {
  const pkg = path.join(appDir, 'node_modules', 'electron');
  let rel = '';
  let version = '';
  try {
    rel = fs.readFileSync(path.join(pkg, 'path.txt'), 'utf8').trim();
  } catch {}
  try {
    version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version;
  } catch {}
  const exeName = rel || (process.platform === 'win32' ? 'electron.exe' : 'electron');
  const candidates = [path.join(pkg, 'dist', exeName)];
  if (process.env.CLAUDE_PLUGIN_DATA && version) {
    candidates.push(path.join(process.env.CLAUDE_PLUGIN_DATA, `electron-${version}`, 'dist', exeName));
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function launchApp() {
  if (process.env.HUDDLE_NO_AUTOSTART) return;
  const appDir = path.resolve(__dirname, '..');
  const exe = electronBinary(appDir);
  if (!exe) return; // not set up yet: nothing to start
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // set inside VS Code; would make Electron act as plain Node
  spawn(exe, [appDir], { cwd: appDir, env, detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// Plugin only: the app has not been downloaded yet. Say so at most once a day,
// in a line the user sees (Claude does not get it as context).
function setupNotice() {
  if (!fromPlugin || !pluginData) return '';
  const stamp = path.join(pluginData, 'setup-notice.json');
  try {
    const last = JSON.parse(fs.readFileSync(stamp, 'utf8')).at;
    if (Date.now() - last < 24 * 3600 * 1000) return '';
  } catch {}
  try {
    fs.mkdirSync(pluginData, { recursive: true });
    fs.writeFileSync(stamp, JSON.stringify({ at: Date.now() }));
  } catch {}
  return JSON.stringify({
    systemMessage: 'Agent Huddle is installed but its app is not set up yet. Run /agent-huddle:setup once (downloads Electron, about 100 MB).',
  });
}

// The app could not be reached.
function unreachable(body) {
  if (mode === 'status') return quit();
  try {
    if (JSON.parse(body).hook_event_name === 'SessionStart') {
      if (electronBinary(path.resolve(__dirname, '..'))) launchApp();
      else {
        const notice = setupNotice();
        if (notice) return process.stdout.write(notice, quit);
      }
    }
  } catch {}
  quit();
}

// Plugin only: install-hooks already registered Huddle in settings.json, so
// those hooks report this event; this copy stays quiet.
function installedElsewhere() {
  if (!fromPlugin) return false;
  try {
    const { settingsFile, settingsHaveHuddleHooks } = require('./shared');
    return settingsHaveHuddleHooks(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')));
  } catch {
    return false;
  }
}

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', quit);
process.stdin.on('end', () => {
  let body = Buffer.concat(chunks);
  if (installedElsewhere()) return quit();
  if (mode === 'status') {
    try {
      body = statusBody(body);
    } catch {
      return quit();
    }
  }

  let runtime;
  try {
    runtime = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8'));
  } catch {
    return unreachable(body);
  }

  const req = http.request(
    {
      host: '127.0.0.1',
      port: runtime.port,
      path: '/event',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        'x-huddle-token': runtime.token,
        'x-huddle-mode': mode,
        // Our parent is the Claude Code process; the app uses it to notice a session that died.
        'x-huddle-ppid': String(process.ppid || ''),
      },
    },
    (res) => {
      const out = [];
      res.on('data', (c) => out.push(c));
      res.on('error', quit);
      res.on('end', () => {
        // The status bridge never prints: its stdout would become the user's status line.
        if (res.statusCode === 200 && out.length && mode !== 'status') {
          process.stdout.write(Buffer.concat(out), quit);
        } else {
          quit();
        }
      });
    }
  );
  // Refused connection = stale runtime file from an app that is gone.
  req.on('error', (err) => (err.code === 'ECONNREFUSED' ? unreachable(body) : quit()));
  req.end(body);
});
