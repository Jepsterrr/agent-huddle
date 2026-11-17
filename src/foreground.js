// Answers three questions about the desktop, so the huddle can stay out of the
// way: which window is the user working in, is a given agent running inside
// that window, and is something full-screen going on.
//
// Windows only. Anywhere else, or if the native bridge fails to load,
// isAvailable() is false and the huddle simply stays visible.

const path = require('path');
const os = require('os');

// Used only when an agent's own process is unknown, so its window cannot be
// worked out: then any of these in the foreground counts as "looking at it".
const EDITORS = new Set([
  'code.exe', 'code - insiders.exe', 'cursor.exe', 'windsurf.exe', 'vscodium.exe', 'positron.exe',
  'kiro.exe', 'trae.exe', 'zed.exe', 'sublime_text.exe', 'devenv.exe', 'claude.exe',
  'idea64.exe', 'pycharm64.exe', 'webstorm64.exe', 'phpstorm64.exe', 'rider64.exe', 'goland64.exe',
  'clion64.exe', 'rubymine64.exe', 'datagrip64.exe', 'rustrover64.exe', 'studio64.exe',
  'windowsterminal.exe', 'conhost.exe', 'openconsole.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe',
  'wezterm-gui.exe', 'alacritty.exe', 'mintty.exe', 'warp.exe', 'hyper.exe', 'tabby.exe',
]);

// Apps that run many project windows in one process and put the project
// folder in the window title: the title tells which project is in front.
const TITLED = /^(code|code - insiders|cursor|windsurf|vscodium|positron|kiro|trae|zed|\w+64)\.exe$/;

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TH32CS_SNAPPROCESS = 0x2;
// SHQueryUserNotificationState: 2 = full-screen app, 3 = full-screen Direct3D, 4 = presentation mode
const BUSY_STATES = new Set([2, 3, 4]);

let api = null;
try {
  if (process.platform === 'win32') {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const shell32 = koffi.load('shell32.dll');
    const ENTRY = koffi.struct('PROCESSENTRY32W', {
      dwSize: 'uint32',
      cntUsage: 'uint32',
      th32ProcessID: 'uint32',
      th32DefaultHeapID: 'uintptr_t',
      th32ModuleID: 'uint32',
      cntThreads: 'uint32',
      th32ParentProcessID: 'uint32',
      pcPriClassBase: 'int32',
      dwFlags: 'uint32',
      szExeFile: koffi.array('uint16', 260),
    });
    const EnumProc = koffi.proto('bool __stdcall HuddleEnumWindowsProc(void* hwnd, intptr_t lParam)');
    api = {
      EnumWindows: user32.func('bool __stdcall EnumWindows(HuddleEnumWindowsProc* cb, intptr_t lParam)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void* hWnd)'),
      IsIconic: user32.func('bool __stdcall IsIconic(void* hWnd)'),
      ShowWindow: user32.func('bool __stdcall ShowWindow(void* hWnd, int cmd)'),
      SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(void* hWnd)'),
      entrySize: koffi.sizeof(ENTRY),
      GetForegroundWindow: user32.func('void* __stdcall GetForegroundWindow()'),
      GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(void* hWnd, _Out_ uint32* pid)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void* hWnd, _Out_ uint16* text, int max)'),
      OpenProcess: kernel32.func('void* __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
      QueryFullProcessImageNameW: kernel32.func(
        'bool __stdcall QueryFullProcessImageNameW(void* h, uint32 flags, _Out_ uint16* name, _Inout_ uint32* size)'
      ),
      CloseHandle: kernel32.func('bool __stdcall CloseHandle(void* h)'),
      CreateToolhelp32Snapshot: kernel32.func('void* __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)'),
      Process32FirstW: kernel32.func('bool __stdcall Process32FirstW(void* snap, _Inout_ PROCESSENTRY32W* entry)'),
      Process32NextW: kernel32.func('bool __stdcall Process32NextW(void* snap, _Inout_ PROCESSENTRY32W* entry)'),
      SHQueryUserNotificationState: shell32.func('int __stdcall SHQueryUserNotificationState(_Out_ int* state)'),
    };
  }
} catch (err) {
  console.error('[huddle] window detection unavailable:', err.message);
  api = null;
}

const text = (buf, len) => String.fromCharCode(...buf.subarray(0, len));

const names = new Map(); // pid -> exe name, so a process is only opened once

function exeName(pid) {
  if (names.has(pid)) return names.get(pid);
  let name = '';
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (handle) {
    try {
      const buf = new Uint16Array(1024);
      const size = [buf.length];
      if (api.QueryFullProcessImageNameW(handle, 0, buf, size)) {
        name = path.win32.basename(text(buf, size[0])).toLowerCase();
      }
    } finally {
      api.CloseHandle(handle);
    }
  }
  if (names.size > 500) names.clear();
  names.set(pid, name);
  return name;
}

// { pid, name, title } of the foreground window, or null while nothing has focus.
function foreground() {
  if (!api) return null;
  const hwnd = api.GetForegroundWindow();
  if (!hwnd) return null;
  const pid = [0];
  api.GetWindowThreadProcessId(hwnd, pid);
  if (!pid[0]) return null;
  const buf = new Uint16Array(512);
  const len = api.GetWindowTextW(hwnd, buf, buf.length);
  return { pid: pid[0], name: exeName(pid[0]), title: len > 0 ? text(buf, len) : '' };
}

// The foreground window as { hwnd, pid }, to hand focus back to it later.
function foregroundHandle() {
  if (!api) return null;
  const hwnd = api.GetForegroundWindow();
  if (!hwnd) return null;
  const pid = [0];
  api.GetWindowThreadProcessId(hwnd, pid);
  return { hwnd, pid: pid[0] };
}

// Give the foreground back to a window from foregroundHandle(). Windows only
// allows it while this app is the one in front, which is when it is used.
function activate(handle) {
  if (!api || !handle?.hwnd) return false;
  if (api.IsIconic(handle.hwnd)) return false; // minimised meanwhile: leave it
  return !!api.SetForegroundWindow(handle.hwnd);
}

// The pids of every process above `pid`: its parent, grandparent and so on.
// For an agent this chain leads to the editor or terminal it is running in.
function ancestors(pid) {
  const chain = [];
  if (!api || !pid) return chain;
  const parents = new Map();
  const snap = api.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!snap) return chain;
  try {
    const entry = { dwSize: api.entrySize };
    for (let ok = api.Process32FirstW(snap, entry); ok; ok = api.Process32NextW(snap, entry)) {
      parents.set(entry.th32ProcessID, entry.th32ParentProcessID);
    }
  } finally {
    api.CloseHandle(snap);
  }
  const seen = new Set([pid]);
  for (let p = parents.get(pid); p && !seen.has(p) && chain.length < 40; p = parents.get(p)) {
    seen.add(p);
    chain.push(p);
  }
  return chain;
}

// The direct child processes of `pid`: [{ pid, name }], name in lower case.
function children(pid) {
  const out = [];
  if (!api || !pid) return out;
  const snap = api.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!snap) return out;
  try {
    const entry = { dwSize: api.entrySize };
    for (let ok = api.Process32FirstW(snap, entry); ok; ok = api.Process32NextW(snap, entry)) {
      if (entry.th32ParentProcessID !== pid) continue;
      const chars = entry.szExeFile;
      const end = chars.indexOf(0);
      out.push({ pid: entry.th32ProcessID, name: String.fromCharCode(...chars.slice(0, end < 0 ? chars.length : end)).toLowerCase() });
    }
  } finally {
    api.CloseHandle(snap);
  }
  return out;
}

// Friendly names for the places an agent can live, for labels like "In VS Code".
const HOSTS = [
  [/^code( - insiders)?.exe$/, 'VS Code'],
  [/^cursor.exe$/, 'Cursor'],
  [/^windsurf.exe$/, 'Windsurf'],
  [/^claude.exe$/, 'Claude'],
  [/^(windowsterminal|conhost|openconsole|cmd|powershell|pwsh|wezterm-gui|alacritty|mintty|warp|hyper|tabby).exe$/, 'the terminal'],
];

// The top-level windows of the app an agent runs in, front-most first.
// chain: the pids from ancestors().
function windowsOf(chain) {
  const found = [];
  if (!api || !chain.length) return found;
  const wanted = new Set(chain);
  const buf = new Uint16Array(512);
  api.EnumWindows((hwnd) => {
    const pid = [0];
    api.GetWindowThreadProcessId(hwnd, pid);
    if (wanted.has(pid[0]) && api.IsWindowVisible(hwnd)) {
      const len = api.GetWindowTextW(hwnd, buf, buf.length);
      if (len > 0) found.push({ hwnd, pid: pid[0], name: exeName(pid[0]), title: text(buf, len) });
    }
    return true;
  }, 0);
  // The app nearest the agent in the chain wins (a terminal inside an editor, say).
  const order = new Map(chain.map((p, i) => [p, i]));
  return found.sort((a, b) => order.get(a.pid) - order.get(b.pid));
}

// The window this agent lives in: for editors with one window per project,
// the one whose title names the project.
function windowFor(chain, cwd) {
  const all = windowsOf(chain);
  if (!all.length) return null;
  const app = all.filter((w) => w.pid === all[0].pid);
  return (TITLED.test(app[0].name) && app.find((w) => titleMatches(w.title, cwd))) || app[0];
}

// What to call the place this agent runs in, or '' if unknown.
function hostName(chain, cwd) {
  const w = windowFor(chain, cwd);
  if (!w) return '';
  const hit = HOSTS.find(([re]) => re.test(w.name));
  return hit ? hit[1] : TITLED.test(w.name) ? 'the editor' : '';
}

// Bring the agent's window to the front. Returns false if it could not be found.
function focusWindow(chain, cwd) {
  const w = windowFor(chain, cwd);
  if (!w) return false;
  if (api.IsIconic(w.hwnd)) api.ShowWindow(w.hwnd, 9); // SW_RESTORE
  return !!api.SetForegroundWindow(w.hwnd);
}

// A full-screen app, game or presentation is on screen.
function isBusy() {
  if (!api) return false;
  const state = [0];
  return api.SHQueryUserNotificationState(state) === 0 && BUSY_STATES.has(state[0]);
}

// Does this window title belong to the project at `cwd`? Checks the last few
// folder names, since an agent may have been started in a subfolder.
function titleMatches(title, cwd) {
  const t = String(title || '').toLowerCase();
  const homeParts = new Set(os.homedir().toLowerCase().split(/[\\/]/));
  const parts = String(cwd || '')
    .toLowerCase()
    .split(/[\\/]/)
    .filter((p) => p.length >= 3 && !p.endsWith(':') && !homeParts.has(p));
  return parts.slice(-3).some((p) => t.includes(p));
}

module.exports = {
  isAvailable: () => !!api,
  foreground,
  foregroundHandle,
  activate,
  ancestors,
  children,
  windowFor,
  hostName,
  focusWindow,
  isBusy,
  titleMatches,
  isEditor: (name) => EDITORS.has(name),
  hasProjectTitle: (name) => TITLED.test(name),
};
