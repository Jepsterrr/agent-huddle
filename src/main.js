const { app, BrowserWindow, ipcMain, screen, Tray, Menu } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const paths = require('./paths');
const { Store } = require('./store');
const { startServer } = require('./server');
const focus = require('./foreground');
const { trayIcon } = require('./tray-icon');
const { peakPct } = require('./usage');
const { StartWatch } = require('./started');
const { RULE_ROWS, cleanRouting, nextModel, routingFile } = require('./routing');
const builder = require('./builder');
const { execFile } = require('child_process');

// The window is a fixed-size transparent canvas. Clicks pass straight through
// it except where the renderer says there is something to hit.
const WIN_W = 480;
let WIN_H = 800; // capped to the display in createWindow
const MARGIN = 12;

// Write diffs compare against the file on disk: read locally, never sent anywhere.
const { readForDiff } = require('./diff');
const store = new Store({ readFile: readForDiff });
let win = null;
let tray = null;
let server = null;
let drag = null;
let pushTimer = null;
let quitting = false;

// ---- what decides whether the huddle is on screen ----
//
//   shown = agents exist
//           && !userHidden          minimised to the tray with the header ×
//           && !dnd                 "do not disturb"
//           && !busy                a full-screen app or presentation is running
//           && !every agent is in view   (the user is already in its window)
//
// Hiding never costs a prompt: Claude Code shows its own dialog in the agent's
// window at the same time, so the user can always answer where they are.
let shown = false;
let userHidden = false;
let busy = false;
let lastFg = null; // the window the user is working in: { pid, name, title }
let inView = new Set(); // ids of sessions whose own window is that one
const chains = new Map(); // session id -> { pid, set: pids of the processes it runs inside }
let focusTimer = null;
let fadeTimer = null;
let refreshing = false;

// Settings, kept in config.json.
const settings = {
  autoHide: true, // hide while the user is in the agent's own window
  hideFullscreen: true, // stay away from full-screen apps and presentations
  protect: true, // keep the huddle out of screen sharing and screenshots
  dnd: false, // do not disturb: never show, never hold a prompt
  sound: true, // chime when an agent needs you or finishes
  collapsed: false, // the list is folded up into the header
  showUsage: true, // quota / cost meter in the header (data comes from the statusLine bridge)
  usageTray: true, // tray icon turns red near a quota limit
  autoBuild: false, // a finished plan starts a background builder session by itself
};
const MAX_BUILDS = 1; // background builders at once, to spare the quota
const USAGE_WARN = 90; // percent at which the tray warns
let settingsOpen = false; // the settings view is showing; keeps the huddle on screen
// Subagent model rules (routing.js); written to routing.json for the plugin module.
let routing = cleanRouting(null);

function writeRouting() {
  try {
    fs.writeFileSync(path.join(paths.home, 'routing.json'), JSON.stringify(routingFile(routing), null, 2));
  } catch (err) {
    console.error('[huddle] could not write routing.json:', err.message);
  }
}

const loginOpts = () => ({ path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', restore);
  app.whenReady().then(start);
}

async function start() {
  fs.mkdirSync(paths.home, { recursive: true });
  const cfg = loadConfig();
  for (const key of Object.keys(settings)) if (typeof cfg[key] === 'boolean') settings[key] = cfg[key];
  routing = cleanRouting(cfg.routing);
  writeRouting(); // the file always says what the settings say (off by default)
  if (!focus.isAvailable()) settings.autoHide = settings.hideFullscreen = false;
  // As a plugin the app's folder changes with every update; keep the Windows
  // start-up entry pointing at the folder that is running now.
  if (cfg.startWithWindows === true) app.setLoginItemSettings({ ...loginOpts(), openAtLogin: true });

  const token = crypto.randomBytes(24).toString('hex');
  server = await startServer({
    token,
    onEvent: (payload, mode, meta) => {
      debugEvent(payload, mode);
      return store.handle(payload, mode === 'wait' && !holdsPromptsFor() ? 'notify' : mode, meta);
    },
  });
  fs.writeFileSync(
    paths.runtimeFile,
    JSON.stringify({ port: server.address().port, token, pid: process.pid }),
    { mode: 0o600 }
  );

  createWindow();
  createTray();
  store.on('change', () => {
    watchStarts();
    // A minimised huddle comes back when an agent is waiting on an answer here.
    if (store.waiters.size) userHidden = false;
    for (const id of chains.keys()) if (!store.sessions.has(id)) chains.delete(id);
    watchFocus();
    refreshView();
    updateTray();
    schedulePush();
  });

  // Clear out agents whose Claude Code process has died without a goodbye,
  // and let a quota window that has reset drop out of the tray.
  setInterval(() => {
    store.reap(isAlive);
    store.expireOutbox(); // a session that stopped asking will not collect what waits for it
    updateTray();
    schedulePush(); // which sessions can take a plan changes with time alone
  }, 10_000);

  screen.on('display-removed', keepOnScreen);
  screen.on('display-metrics-changed', keepOnScreen);

  ipcMain.on('ready', push);
  ipcMain.on('hide', minimiseToTray);
  ipcMain.on('set-setting', (_e, key, value) => {
    if (key === 'startWithWindows') {
      app.setLoginItemSettings({ ...loginOpts(), openAtLogin: !!value });
      saveConfig({ startWithWindows: !!value });
      return push();
    }
    if (Object.hasOwn(settings, key) && typeof value === 'boolean') setSetting(key, value);
  });
  ipcMain.on('settings-open', (_e, open) => {
    settingsOpen = !!open;
    updateVisibility();
  });
  ipcMain.on('reset-position', resetPosition);
  ipcMain.on('quit', () => app.quit());
  ipcMain.on('hit', (_e, hit) => {
    if (win && !drag) win.setIgnoreMouseEvents(!hit, { forward: true });
  });
  ipcMain.on('keyboard', (_e, want) => setKeyboard(!!want));
  // 'enabled' turns the rules on or off; a row's key moves it to its next model.
  ipcMain.on('set-routing', (_e, key) => {
    if (key === 'enabled') routing.enabled = !routing.enabled;
    else if (RULE_ROWS.some(([k]) => k === key)) routing[key] = nextModel(routing[key]);
    else return;
    saveConfig({ routing });
    writeRouting();
    push();
  });
  ipcMain.on('answer', (_e, pendingId, resp) => store.answer(pendingId, resp));
  ipcMain.on('send-plan', (_e, fromId, toId) => store.sendPlan(String(fromId), String(toId)));
  ipcMain.on('build-plan', (_e, plannerId) => startBuild(String(plannerId), false));
  ipcMain.on('stop-build', (_e, plannerId) => stopBuild(String(plannerId)));
  store.on('plan-ready', (plannerId) => {
    if (settings.autoBuild) startBuild(plannerId, true);
  });
  ipcMain.on('cancel-plan', (_e, fromId) => store.cancelPlan(String(fromId)));
  ipcMain.on('dismiss', (_e, sessionId) => store.dismiss(sessionId));
  ipcMain.on('focus', (_e, sessionId) => {
    const s = store.sessions.get(sessionId);
    if (s) goToAgent(s);
  });
  ipcMain.on('drag-start', () => {
    if (!win) return;
    const [x, y] = win.getPosition();
    drag = { cursor: screen.getCursorScreenPoint(), x, y };
  });
  ipcMain.on('drag-move', () => {
    if (!win || !drag) return;
    const c = screen.getCursorScreenPoint();
    // setBounds, not setPosition: keeps the size from drifting on scaled displays.
    win.setBounds({
      x: drag.x + c.x - drag.cursor.x,
      y: drag.y + c.y - drag.cursor.y,
      width: WIN_W,
      height: WIN_H,
    });
  });
  ipcMain.on('drag-end', () => {
    if (!win || !drag) return;
    drag = null;
    const [x, y] = win.getPosition();
    saveConfig({ x, y });
    push();
  });
}

// ---- window ----

function createWindow() {
  WIN_H = Math.min(WIN_H, screen.getPrimaryDisplay().workArea.height - 2 * MARGIN);
  const pos = initialPosition();
  win = new BrowserWindow({
    ...pos,
    width: WIN_W,
    height: WIN_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Clicks never take the focus, so the huddle is not in Alt+Tab and the
    // window you were in stays the active one. It only becomes focusable while
    // you type an answer (see 'keyboard' below).
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required', // the "agent needs you" chime
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setContentProtection(settings.protect);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', updateVisibility);
  // Closing the window (Alt+F4) only minimises it. Quitting is a tray menu choice.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    minimiseToTray();
  });
  win.on('closed', () => (win = null));
  // You moved to another window while typing: stop being focusable (and do not
  // pull the focus back, you chose where to be).
  win.on('blur', () => {
    if (win && win.isFocusable()) {
      typingFrom = null;
      win.setFocusable(false);
    }
  });
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

function onScreen(x, y) {
  const wa = screen.getDisplayMatching({ x, y, width: WIN_W, height: WIN_H }).workArea;
  return {
    x: clamp(x, wa.x, wa.x + wa.width - WIN_W),
    y: clamp(y, wa.y, wa.y + wa.height - WIN_H),
  };
}

function defaultPosition() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - WIN_W - MARGIN, y: wa.y + MARGIN };
}

function initialPosition() {
  const cfg = loadConfig();
  return Number.isFinite(cfg.x) && Number.isFinite(cfg.y) ? onScreen(cfg.x, cfg.y) : defaultPosition();
}

// Monitor unplugged or resolution changed: make sure the window is still reachable.
function keepOnScreen() {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  win.setBounds({ ...onScreen(x, y), width: WIN_W, height: WIN_H });
  push();
}

// Which corner of its display the window is nearest; the UI hugs that corner.
function alignment() {
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  return {
    h: b.x + b.width / 2 < wa.x + wa.width / 2 ? 'left' : 'right',
    v: b.y + b.height / 2 < wa.y + wa.height / 2 ? 'top' : 'bottom',
  };
}

function schedulePush() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    push();
  }, 40);
}

function push() {
  // Nothing is drawn while hidden; the state is sent again when it is shown.
  if (!win || win.isDestroyed() || !shown) return;
  // host: what to call the app each agent runs in ("VS Code", "the terminal", …).
  const sessions = store.snapshot().map((s) => ({
    ...s,
    host: chainEntry(s)?.host || 'the editor',
    canReceive: store.canReceive(s), // its plugin module is polling: it can take a plan
  }));
  win.webContents.send('state', {
    sessions,
    usage: store.usageNow(),
    align: alignment(),
    settings: {
      ...settings,
      startWithWindows: app.getLoginItemSettings(loginOpts()).openAtLogin,
      canDetectWindows: focus.isAvailable(),
      routing,
      routingRows: RULE_ROWS,
    },
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0: only checks that the process exists
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// ---- background builders (builder.js) ----
//
// A finished plan (by itself when "Build plans automatically" is on, else by
// the Build button) starts `claude --bg` in the planner's folder. Its questions
// come to the huddle; when it is done its report goes back to the planner.

function startBuild(plannerId, auto) {
  const s = store.sessions.get(plannerId);
  if (!s?.plan || ['starting', 'running'].includes(s.plan.build?.status)) return;
  if (store.runningBuilds() >= MAX_BUILDS) {
    if (!auto) store.buildStarting(plannerId) && store.buildFailed(plannerId, 'Another build is running; one at a time.');
    return;
  }
  const peak = peakPct(store.usageNow());
  if (auto && peak != null && peak >= USAGE_WARN) return; // close to the quota: wait for a click
  const exe = builder.findClaude();
  store.buildStarting(plannerId);
  if (!exe) return store.buildFailed(plannerId, 'The claude program was not found.');

  const model = routing.enabled && routing.implement ? routing.implement : null;
  let out = '';
  let child;
  try {
    const file = s.plan.path ? null : builder.writePlanFile(paths.home, s.plan);
    const args = builder.builderArgs({ title: s.plan.title, prompt: builder.builderPrompt(store.planPromptFor(plannerId, file)), model });
    child = spawn(exe, args, { cwd: s.cwd || undefined, env: builder.builderEnv(), windowsHide: true });
  } catch (err) {
    return store.buildFailed(plannerId, err.message);
  }
  child.stdout?.on('data', (c) => (out += c));
  child.stderr?.on('data', (c) => (out += c));
  child.on('error', (err) => store.buildFailed(plannerId, err.message));
  child.on('close', () => {
    const bg = builder.parseBackgrounded(out);
    if (!bg) return store.buildFailed(plannerId, out.trim().split('\n').slice(-2).join(' ') || 'Could not start');
    store.buildLaunched(plannerId, { bgId: bg.id });
    store.noticeBuilding(plannerId, builder.builderName(s.plan.title));
    linkBuilder(plannerId, exe, bg.id, 0);
  });
}

// Find the builder's session id, so its card can be tied to the plan.
function linkBuilder(plannerId, exe, bgId, tries) {
  execFile(exe, ['agents', '--json'], { env: builder.builderEnv(), windowsHide: true, timeout: 15_000 }, (err, stdout) => {
    const sessionId = err ? null : builder.sessionIdOf(stdout, bgId);
    if (sessionId) store.buildLaunched(plannerId, { sessionId });
    else if (tries < 5) setTimeout(() => linkBuilder(plannerId, exe, bgId, tries + 1), 2000);
  });
}

function stopBuild(plannerId) {
  const b = store.sessions.get(plannerId)?.plan?.build;
  const exe = builder.findClaude();
  if (b?.bgId && exe) execFile(exe, ['stop', b.bgId], { env: builder.builderEnv(), windowsHide: true, timeout: 15_000 }, () => {});
  store.buildStopped(plannerId);
}

// ---- keyboard: only while typing ----
//
// The huddle normally cannot take the focus (focusable: false). A text field
// asks for the keyboard; the window you were in is remembered, and once the
// typing is over it gets the focus back, unless you have moved on yourself.
let typingFrom = null;

function setKeyboard(want) {
  if (!win || win.isDestroyed()) return;
  if (want) {
    if (win.isFocusable()) return;
    const fg = focus.foregroundHandle();
    typingFrom = fg && fg.pid !== process.pid ? fg : null;
    win.setFocusable(true);
    win.focus();
    return;
  }
  if (!win.isFocusable()) return;
  const stillHere = focus.foregroundHandle()?.pid === process.pid;
  win.setFocusable(false);
  if (stillHere && typingFrom) focus.activate(typingFrom);
  typingFrom = null;
}

// ---- troubleshooting ----
//
// Off unless the app is started with HUDDLE_DEBUG_EVENTS=1. Writes only which
// event arrived and which fields it had: never tool input, commands, prompts,
// paths or tokens. File: ~/.agent-huddle/events.log
function debugEvent(p, mode) {
  if (!process.env.HUDDLE_DEBUG_EVENTS || !p || typeof p !== 'object') return;
  const line = {
    at: new Date().toISOString(),
    mode,
    event: p.hook_event_name,
    tool: p.tool_name,
    agent_id: p.agent_id ? 'present' : 'absent',
    agent_type: typeof p.agent_type === 'string' ? p.agent_type : undefined,
    fields: Object.keys(p).sort(),
    // Names only, never values: which fields a tool's input and result carry.
    input_fields: p.tool_input && typeof p.tool_input === 'object' ? Object.keys(p.tool_input).sort() : undefined,
    response_fields: p.tool_response && typeof p.tool_response === 'object' ? Object.keys(p.tool_response).sort() : undefined,
  };
  try {
    fs.appendFileSync(path.join(paths.home, 'events.log'), JSON.stringify(line) + '\n');
  } catch {}
}

// ---- prompts answered in the editor while the command runs ----
//
// See started.js. Runs only while a Bash/PowerShell prompt is held for a
// session whose Claude Code process is known, once a second.
const starts = new StartWatch();
let startTimer = null;
let checkingStarts = false;

function watchStarts() {
  if (checkingStarts) return;
  const waits = focus.isAvailable() ? store.shellWaits() : [];
  starts.keep(waits.map((w) => w.id));
  if (!waits.length) {
    clearInterval(startTimer);
    startTimer = null;
    return;
  }
  checkStarts(waits); // takes the baseline at once for a new prompt
  if (!startTimer) startTimer = setInterval(watchStarts, 500); // stops itself when nothing is held
}

function checkStarts(waits) {
  checkingStarts = true;
  try {
    const kids = new Map(); // pid -> children, one snapshot per Claude Code process
    for (const w of waits) {
      if (!kids.has(w.pid)) kids.set(w.pid, focus.children(w.pid));
      if (starts.check(w.id, kids.get(w.pid), store.otherRunningShells(w.sessionId))) store.releaseStarted(w.id);
    }
  } catch (err) {
    console.error('[huddle] start check failed:', err.message);
  } finally {
    checkingStarts = false;
  }
}

// ---- visibility ----

// The processes an agent runs inside, from its Claude Code process up to the
// editor or terminal. Worked out once per session; it does not change.
function chainEntry(s) {
  if (!s.pid) return null;
  let c = chains.get(s.id);
  if (!c || c.pid !== s.pid) {
    const list = focus.ancestors(s.pid);
    c = { pid: s.pid, list, set: new Set(list), host: focus.hostName(list, s.cwd) };
    chains.set(s.id, c);
  }
  return c;
}

const chainFor = (s) => chainEntry(s)?.set || null;

// Bring the agent's own window forward, whatever app it runs in. VS Code on
// the project folder is the fallback when that window cannot be found.
function goToAgent(s) {
  const c = chainEntry(s);
  if (!(c && focus.focusWindow(c.list, s.cwd))) openInVSCode(s.cwd);
}

// Is the user looking at the very window this agent runs in?
function sessionInView(s) {
  const fg = lastFg;
  if (!settings.autoHide || !fg) return false;
  const chain = chainFor(s);
  // Agent's process unknown: fall back to "some editor or terminal is in front".
  if (!chain || !chain.size) return focus.isEditor(fg.name);
  if (!chain.has(fg.pid)) return false;
  // One editor process can hold many project windows; the title says which.
  return focus.hasProjectTitle(fg.name) ? focus.titleMatches(fg.title, s.cwd) : true;
}

// Should the huddle hold on to permission prompts and questions?
//
// Yes, even while the user is in the agent's own window. Measured against
// Claude Code 2.1.322: its own Yes/No dialog is shown at the same time as the
// hook is held, and whichever side answers first wins. So holding never hides
// a prompt from the editor, and it keeps the buttons here working if the user
// walks away mid-prompt. Only "do not disturb" opts out.
function holdsPromptsFor() {
  return !settings.dnd;
}

function refreshView() {
  if (refreshing) return;
  refreshing = true;
  try {
    const next = new Set();
    for (const s of store.sessions.values()) if (sessionInView(s)) next.add(s.id);
    inView = next;
  } finally {
    refreshing = false;
  }
  updateVisibility();
}

// Poll which window has focus, but only while there are agents to show.
function watchFocus() {
  const on = store.sessions.size > 0 && (settings.autoHide || settings.hideFullscreen);
  if (!on) {
    clearInterval(focusTimer);
    focusTimer = null;
    return;
  }
  if (focusTimer) return;
  checkFocus();
  focusTimer = setInterval(checkFocus, 300);
}

function checkFocus() {
  let changed = false;
  const fg = focus.foreground();
  // No focused window (mid-switch) or the huddle itself: keep the last answer.
  if (fg && fg.pid !== process.pid && (!lastFg || fg.pid !== lastFg.pid || fg.title !== lastFg.title)) {
    lastFg = fg;
    changed = true;
  }
  const nowBusy = settings.hideFullscreen && focus.isBusy();
  if (nowBusy !== busy) {
    busy = nowBusy;
    changed = true;
  }
  if (changed) refreshView();
}

function updateVisibility() {
  if (!win || win.isDestroyed()) return;
  const n = store.sessions.size;
  // The settings view is something the user asked for, so it always shows.
  const want = settingsOpen || (n > 0 && !userHidden && !settings.dnd && !busy && inView.size < n);
  if (want === shown) return;
  shown = want;

  clearInterval(fadeTimer);
  let opacity = win.isVisible() ? win.getOpacity() : 0;
  if (want) {
    win.setOpacity(opacity);
    // Start click-through again; the renderer re-claims the mouse when it is over the UI.
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.send('shown');
    win.showInactive();
    push();
  }
  fadeTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return clearInterval(fadeTimer);
    opacity += want ? 0.2 : -0.25;
    if (opacity > 0 && opacity < 1) return win.setOpacity(opacity);
    clearInterval(fadeTimer);
    win.setOpacity(want ? 1 : 0);
    if (!want) win.hide();
  }, 16);
}

function minimiseToTray() {
  userHidden = true;
  updateVisibility();
  updateTray();
  // The first time, point out where it went.
  if (tray && !loadConfig().trayHintShown) {
    saveConfig({ trayHintShown: true });
    tray.displayBalloon({
      title: 'Agent Huddle is still running',
      content: 'Click this icon to bring it back. It also returns when an agent needs you.',
      icon: trayIcon('working'),
    });
  }
}

function restore() {
  userHidden = false;
  if (settings.dnd) setSetting('dnd', false);
  updateVisibility();
  updateTray();
}

function setSetting(key, value) {
  settings[key] = value;
  saveConfig({ [key]: value });
  if (key === 'protect' && win) win.setContentProtection(value);
  if (key === 'dnd' && value) store.releaseAll();
  if (key === 'autoHide' && !value) lastFg = null;
  if (key === 'hideFullscreen' && !value) busy = false;
  watchFocus();
  refreshView();
  updateTray();
  push();
}

function resetPosition() {
  if (!win) return;
  win.setBounds({ ...defaultPosition(), width: WIN_W, height: WIN_H });
  saveConfig({ x: null, y: null });
  push();
}

// Show the huddle with its settings view open, even when there are no agents.
function openSettings() {
  if (!win) return;
  userHidden = false;
  settingsOpen = true;
  updateVisibility();
  win.webContents.send('open-settings');
}

// ---- tray ----

let trayKey = '';

function trayStatus() {
  const all = store.snapshot();
  const needs = all.filter((s) => ['permission', 'question', 'attention'].includes(s.state)).length;
  const working = all.filter((s) => s.state === 'working').length;
  // Someone waiting on you still wins: that is the thing to act on now.
  const peak = peakPct(store.usageNow());
  const nearLimit = settings.usageTray && peak != null && peak >= USAGE_WARN;
  const tone = settings.dnd ? 'paused' : needs ? 'needs' : nearLimit ? 'limit' : working ? 'working' : 'rest';
  let text = all.length ? `${all.length} agent${all.length === 1 ? '' : 's'}` : 'No agents running';
  if (needs) text += ` · ${needs} need${needs === 1 ? 's' : ''} you`;
  else if (working) text += ` · ${working} working`;
  if (settings.usageTray && peak != null) text += ` · ${Math.round(peak)}% of limit used`;
  if (settings.dnd) text += ' · do not disturb';
  return { tone, text };
}

function updateTray() {
  if (!tray) return;
  const { tone, text } = trayStatus();
  const key = `${tone}|${text}`;
  if (key === trayKey) return;
  trayKey = key;
  tray.setImage(trayIcon(tone));
  tray.setToolTip(`Agent Huddle — ${text}`);
}

function createTray() {
  tray = new Tray(trayIcon('rest'));
  // Built each time it opens, so it always matches the current state.
  const popUp = () => {
    const minimised = userHidden || settings.dnd;
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: trayStatus().text, enabled: false },
        { type: 'separator' },
        { label: minimised ? 'Show huddle' : 'Minimise to tray', click: minimised ? restore : minimiseToTray },
        {
          label: 'Do not disturb',
          type: 'checkbox',
          checked: settings.dnd,
          click: (item) => setSetting('dnd', item.checked),
        },
        { label: 'Settings…', click: openSettings },
        { type: 'separator' },
        { label: 'Quit Agent Huddle', click: () => app.quit() },
      ])
    );
  };
  // Left click brings a minimised huddle back; otherwise it opens the menu.
  tray.on('click', () => (userHidden || settings.dnd ? restore() : popUp()));
  tray.on('right-click', popUp);
  updateTray();
}

// ---- VS Code ----

function findVSCode() {
  if (process.platform !== 'win32') return null;
  const candidates = [];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (/Microsoft VS Code(?: Insiders)?[\\/]bin[\\/]?$/i.test(dir)) {
      candidates.push(path.join(dir, '..', 'Code.exe'), path.join(dir, '..', 'Code - Insiders.exe'));
    }
  }
  for (const root of [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'), process.env.ProgramFiles]) {
    if (root) candidates.push(path.join(root, 'Microsoft VS Code', 'Code.exe'));
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// Opening a folder that is already open just brings that window to the front.
function openInVSCode(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const exe = findVSCode() || 'code';
  try {
    const child = spawn(exe, [cwd], { detached: true, stdio: 'ignore', env });
    child.on('error', (err) => console.error('[huddle] could not open VS Code:', err.message));
    child.unref();
  } catch (err) {
    console.error('[huddle] could not open VS Code:', err.message);
  }
}

// ---- config ----

function loadConfig() {
  try {
    // A byte order mark (Notepad, PowerShell 5.1) would make JSON.parse fail.
    return JSON.parse(fs.readFileSync(paths.configFile, 'utf8').replace(/^﻿/, '')) || {};
  } catch {
    return {};
  }
}

function saveConfig(patch) {
  try {
    fs.writeFileSync(paths.configFile, JSON.stringify({ ...loadConfig(), ...patch }, null, 2));
  } catch (err) {
    console.error('[huddle] could not save config:', err.message);
  }
}

// ---- shutdown ----

// The app lives in the tray: it only ends through "Quit" there.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  quitting = true;
  // Let go of every hook that is waiting on us so Claude Code falls back to
  // its own prompts, and stop advertising a server that is about to vanish.
  store.releaseAll();
  try {
    const rt = JSON.parse(fs.readFileSync(paths.runtimeFile, 'utf8'));
    if (rt.pid === process.pid) fs.unlinkSync(paths.runtimeFile);
  } catch {}
  if (server) {
    server.close();
    server.closeAllConnections();
  }
});
