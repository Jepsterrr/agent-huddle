// How risky does a permission request look? Information for the human only.
//
//   assess(tool, input, { cwd, home, extraDirs }) -> { level: 'low'|'medium'|'high', reasons: [] }
//
// This NEVER decides anything. The hook's answer is whatever the user clicks;
// nothing here may allow or deny a request on its own.
//
// It is a pattern matcher over the text Claude Code shows, not a sandbox. It
// deliberately does NOT catch, so "low" must never be read as "safe":
//   - commands hidden behind variables, aliases or functions ($x = 'rm'; & $x -r …)
//   - strings built at run time, base64 other than PowerShell -EncodedCommand,
//     or escapes it does not undo (it only strips " ' \ ^ and backticks)
//   - what a script, `npm run x`, `make`, `python -c`, a git alias or a hook does
//   - a `cd` to a variable or `cd -`: relative paths after it are not judged
//   - symlinks and junctions that point out of the project
//   - writes by commands other than delete/copy/move/tee, `>` / `>>` and
//     Out-File/Set-Content/Add-Content (e.g. `sed -i`, `New-Item`, `git -C`,
//     `tar -C`, a program's own output flag like `-o C:\x`)
//   - environment variables in paths other than the home directory
//   - a single `&` (background job in bash, call operator in PowerShell) is
//     not treated as a separator
//   - what an MCP tool actually does (they are all "medium: unknown effect")
// "Outside the project" means outside the session's cwd; folders added with
// /add-dir are not known here and also count as outside.

const path = require('path');
const os = require('os');

const RANK = { low: 0, medium: 1, high: 2 };

// ---- paths ----

const isWinPath = (p) => /^[a-z]:([\\/]|$)|^\\\\/i.test(p || '');

// Absolute, forward slashes, lower case on Windows, no trailing slash.
function normPath(p, { cwd = '', home = os.homedir() } = {}) {
  if (!p) return '';
  let x = String(p).trim().replace(/^["']+|["']+$/g, '');
  x = x.replace(/^(?:~|\$home|\$env:userprofile|%userprofile%|\$\{?home\}?)(?=$|[\\/])/i, home);
  const win = isWinPath(x) || isWinPath(cwd) || (!cwd && process.platform === 'win32');
  if (win) x = x.replace(/^\/([a-z])(?=\/|$)/i, '$1:'); // Git Bash style /c/Users/…
  const P = win ? path.win32 : path.posix;
  x = cwd && !P.isAbsolute(x) ? P.resolve(cwd, x) : P.normalize(x);
  x = x.replace(/\\/g, '/');
  if (win) x = x.toLowerCase();
  return x.length > 3 ? x.replace(/\/+$/, '') : x;
}

const within = (p, dir) => !!dir && (p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/'));

// Files whose contents are secrets or control Claude itself. Returns a noun, or ''.
function secretKind(p) {
  const n = String(p || '').replace(/\\/g, '/').toLowerCase();
  const b = n.split('/').pop();
  if (/^\.env(\..+)?$/.test(b) && !/\.(example|sample|template|dist|defaults)$/.test(b)) return '.env secrets';
  if (/(^|\/)\.ssh(\/|$)/.test(n) || /^id_(rsa|dsa|ecdsa|ed25519)$/.test(b)) return 'SSH keys';
  if (/\.(pem|key|p12|pfx|ppk|jks|keystore)$/.test(b)) return 'a key file';
  if (/(^|\/)\.aws\/credentials$/.test(n) || /(^|\/)\.docker\/config\.json$/.test(n)) return 'stored credentials';
  if (/^(\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials)$/.test(b)) return 'stored credentials';
  if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(n)) return 'Claude settings';
  return '';
}

// Writing these changes how the project builds, installs or runs.
function configKind(p) {
  const n = String(p || '').toLowerCase();
  const b = n.split('/').pop();
  if (/(^|\/)\.git\//.test(n)) return { level: 'high', reason: 'writes inside .git' };
  if (/(^|\/)\.github\/workflows\//.test(n) || /^\.gitlab-ci\.ya?ml$/.test(b)) return { level: 'medium', reason: 'changes CI' };
  if (/^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|cargo\.lock|poetry\.lock|uv\.lock|gemfile\.lock|composer\.lock|go\.sum)$/.test(b)) {
    return { level: 'medium', reason: 'changes a lockfile' };
  }
  if (b === '.mcp.json' || /(^|\/)\.claude\//.test(n)) return { level: 'medium', reason: 'changes Claude config' };
  if (
    /^(package\.json|cargo\.toml|pyproject\.toml|gemfile|go\.mod|composer\.json|dockerfile|makefile|\.npmrc)$/.test(b) ||
    /^requirements.*\.txt$/.test(b) ||
    /^tsconfig.*\.json$/.test(b) ||
    /^docker-compose.*\.ya?ml$/.test(b) ||
    /\.config\.[cm]?[jt]s$/.test(b) ||
    /^\.eslintrc/.test(b) ||
    /(^|\/)\.vscode\/(settings|tasks|launch)\.json$/.test(n)
  ) {
    return { level: 'medium', reason: 'changes config' };
  }
  return null;
}

// ---- commands ----

// Start of a command word: beginning, whitespace, or a shell separator.
const B = String.raw`(?:^|[\s;&|({]|\$\()`;
const R = (src) => new RegExp(src, 'i');
const SEG = String.raw`[^;&|\n]*`; // rest of this one command

const FETCHERS = String.raw`(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)`;
const RUNNERS = String.raw`(?:sudo\s+)?(?:sh|bash|zsh|iex|invoke-expression|python3?|node|pwsh|powershell)`;

const COMMAND_RULES = [
  // high
  // Each flag is one whole "-…" word, so a long list of flags cannot make the
  // match backtrack exponentially (the old -{1,2}[\w-]+ could split "--a" two ways).
  ['high', 'deletes recursively', R(`${B}rm\\s+(?:-\\S*\\s+)*-(?:[a-z]*r[a-z]*|-recursive)\\b`)],
  ['high', 'deletes recursively', R(`${B}(?:remove-item|ri|rm|del|erase|rd|rmdir)\\b${SEG}\\s-r(?:ecurse)?\\b`)],
  ['high', 'deletes recursively', R(`${B}(?:del|erase|rd|rmdir)\\b${SEG}\\s/s\\b`)],
  ['high', 'deletes recursively', R(`${B}(?:rimraf|npx\\s+rimraf)\\b|${B}find\\b${SEG}\\s-delete\\b`)],
  ['high', 'deletes recursively', R(`${B}(?:get-childitem|gci|ls|dir)\\b[^|;\\n]*\\s-r(?:ecurse)?\\b[^|;\\n]*\\|\\s*(?:remove-item|ri|rm|del)\\b`)],
  ['high', 'force-pushes', R(`${B}git\\s+push\\b${SEG}\\s(?:--force(?:-with-lease)?|-f|\\+\\S+)(?=\\s|$)`)],
  ['high', 'throws away changes', R(`${B}git\\s+reset\\b${SEG}\\s--hard\\b`)],
  ['high', 'throws away changes', R(`${B}git\\s+(?:checkout|restore)\\s+(?:--\\s+)?\\.(?=\\s|$|[;&|])`)],
  ['high', 'deletes untracked files', R(`${B}git\\s+clean\\b${SEG}\\s-[a-z]*f`)],
  ['high', 'runs code from the internet', R(`${FETCHERS}\\b[^;\\n]*\\|\\s*${RUNNERS}\\b`)],
  ['high', 'runs code from the internet', R(`${B}(?:iex|invoke-expression)\\b[^;\\n]*(?:${FETCHERS}|downloadstring|net\\.webclient)`)],
  ['high', 'runs code from the internet', R(`${B}(?:bash|sh|zsh|source|\\.)\\s+<\\(\\s*(?:curl|wget)\\b`)],
  ['high', 'changes permissions recursively', R(`${B}(?:chmod|chown|chgrp)\\s+(?:\\S+\\s+)*-[a-z]*r`)],
  ['high', 'changes permissions recursively', R(`${B}(?:icacls\\b${SEG}\\s/t\\b|takeown\\b${SEG}\\s/r\\b)`)],
  ['high', 'runs as administrator', R(`${B}(?:sudo|doas|gsudo|runas)\\b|-verb\\s+runas\\b`)],
  ['high', 'publishes a package', R(`${B}(?:(?:npm|pnpm|yarn|bun)\\s+(?:\\w+\\s+)?publish|cargo\\s+publish|twine\\s+upload|gem\\s+push|dotnet\\s+nuget\\s+push|vsce\\s+publish)\\b`)],
  ['high', 'runs hidden (encoded) code', R(`${B}(?:powershell|pwsh)(?:\\.exe)?\\b${SEG}\\s-(?:e|ec|enc|encodedcommand)\\s`)],
  ['high', 'writes directly to a disk', R(`${B}(?:format\\s+[a-z]:|mkfs\\S*|diskpart|clear-disk|format-volume|dd\\s+${SEG}\\bof=)`)],
  ['high', 'shuts the computer down', R(`${B}(?:shutdown|stop-computer|restart-computer|reboot|poweroff)\\b`)],
  // medium
  ['medium', 'installs packages', R(`${B}(?:(?:npm|pnpm|bun)\\s+(?:i|install|add|ci)\\b|yarn(?:\\s+(?:add|install)\\b|\\s*$)|(?:pip3?|pipx|uv\\s+pip)\\s+install|(?:uv|poetry)\\s+add|cargo\\s+(?:install|add)|gem\\s+install|go\\s+(?:get|install)|(?:winget|choco|scoop|brew|apt|apt-get|dnf|yum)\\s+install|install-(?:module|package)|dotnet\\s+add\\s+package)\\b`)],
  ['medium', 'runs a package from the internet', R(`${B}(?:npx|pnpx|bunx|uvx|pnpm\\s+dlx|yarn\\s+dlx)\\b`)],
  ['medium', 'pushes to a remote', R(`${B}git\\s+push\\b`)],
  ['medium', 'uses the network', R(`${B}(?:${FETCHERS}|ssh|scp|sftp|rsync|ftp|nc|ncat|telnet|test-netconnection)\\b|${B}git\\s+(?:clone|pull|fetch)\\b`)],
  ['medium', 'deletes files', R(`${B}(?:rm|del|erase|remove-item|ri|rd|rmdir|unlink)\\b`)],
  ['medium', 'deletes a branch', R(`${B}git\\s+branch\\b${SEG}\\s-D\\b`)],
  ['medium', 'changes the registry', R(`${B}reg\\s+(?:add|delete|import)\\b|\\bhk(?:lm|cu|cr|u):`)],
  ['medium', 'changes a security setting', R(`${B}set-executionpolicy\\b`)],
  ['medium', 'stops processes', R(`${B}(?:kill|pkill|killall|taskkill|stop-process)\\b`)],
  ['medium', 'runs code built from text', R(`${B}(?:eval|iex|invoke-expression)\\b`)],
];

const SECRET_IN_COMMAND = [
  ['.env secrets', /(?:^|[\s"'=/\\:(<>])\.env(?!\.(?:example|sample|template|dist|defaults)\b)(?:\.[\w-]+)*(?=$|[\s"'/\\;|&)<>])/i],
  ['SSH keys', /\.ssh(?:[/\\]|\b)|\bid_(?:rsa|dsa|ecdsa|ed25519)\b(?!\.pub)/i],
  // A file name ending, not `obj.key)` in a script: followed by the end, a space, a quote or a separator.
  ['a key file', /[\w-]\.(?:pem|key|p12|pfx|ppk)(?=$|[\s"';|&<>])/i],
  ['stored credentials', /\.aws[/\\]credentials|(?:^|[\s"'/\\])(?:\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials)\b/i],
  ['Claude settings', /\.claude[/\\]settings(?:\.local)?\.json/i],
];

// Drop quoted text, so `echo "a && b"` is not a chain.
const QUOTED = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*')`;
const unquote = (c) => c.replace(new RegExp(QUOTED, 'g'), '""');

// Text that is only a message, never run: commit messages and the like, and
// what echo / Write-Host print. `git commit -m "fix rm -rf bug"` is not a delete.
// (A quoted string given to bash -c / powershell -Command is still read.)
const MESSAGE_ARG = new RegExp(String.raw`((?:^|\s)(?:-m|--message|--body|--title|--subject|--notes|-message)(?:\s+|=))${QUOTED}`, 'gi');
const PRINTED = new RegExp(String.raw`((?:^|[\s;&|(])(?:echo|printf|write-output|write-host)\s+)${QUOTED}`, 'gi');
const blankMessages = (c) => c.replace(MESSAGE_ARG, '$1""').replace(PRINTED, '$1""');

// Commands that only shape output; piping into them is not a "chain".
const FILTERS = new Set([
  'head', 'tail', 'grep', 'rg', 'findstr', 'sort', 'uniq', 'wc', 'less', 'more', 'cat', 'jq', 'cut', 'column', 'tr',
  'select-object', 'select', 'select-string', 'sls', 'where-object', 'where', '?', 'sort-object', 'sort',
  'format-table', 'ft', 'format-list', 'fl', 'out-string', 'measure-object', 'measure', 'out-host', 'group-object',
]);
// Undo the cheap disguises: r"m" -rf, R`emove-Item, r\m, r^m.
const undisguise = (c) => c.replace(/["'\\^`]/g, '');

function redirectTargets(c) {
  const out = [];
  const re = /(?:^|[^\d&<>=-])\d?>{1,2}(?!&)\s*("([^"]+)"|'([^']+)'|([^\s;&|<>]+))/g;
  let m;
  while ((m = re.exec(c))) out.push(m[2] || m[3] || m[4]);
  const ps = /\b(?:out-file|set-content|add-content|tee-object)\s+(?:-(?:file)?path\s+)?("([^"]+)"|'([^']+)'|([^\s;&|-][^\s;&|]*))/gi;
  while ((m = ps.exec(c))) out.push(m[2] || m[3] || m[4]);
  return out.filter((t) => t && !/^(?:\/dev\/(?:null|stdout|stderr)|nul|\$null)$/i.test(t));
}

// Split a command line into its commands (on ; && || | and newlines, not
// inside quotes), each as { raw, args } with the quotes taken off the args.
function splitCommands(c) {
  const out = [];
  let raw = '';
  let args = [];
  let tok = '';
  let has = false; // the current token exists (it may be an empty "")
  let q = '';
  const endTok = () => {
    if (has) args.push(tok);
    tok = '';
    has = false;
  };
  const endCmd = () => {
    endTok();
    if (args.length) out.push({ raw, args });
    raw = '';
    args = [];
  };
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (q) {
      if (ch === q) q = '';
      else tok += ch;
      raw += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
      raw += ch;
    } else if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && c[i + 1] === '&')) {
      if ((ch === '|' && c[i + 1] === '|') || ch === '&') i++;
      endCmd();
    } else if (/\s/.test(ch)) {
      endTok();
      raw += ch;
    } else {
      tok += ch;
      has = true;
      raw += ch;
    }
  }
  endCmd();
  return out;
}

const cmdName = (a) => String(a || '').toLowerCase().split(/[\\/]/).pop().replace(/\.exe$/, '');
const DELETERS = new Set(['rm', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'ri', 'unlink', 'rimraf', 'shred']);
const COPIERS = new Set(['cp', 'mv', 'copy', 'move', 'xcopy', 'robocopy', 'copy-item', 'cpi', 'move-item', 'mi', 'rsync']);
const CHDIR = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl']);
// PowerShell parameters whose value is not a path we care about.
const VALUE_FLAGS = new Set(['-include', '-exclude', '-filter', '-credential', '-stream', '-erroraction', '-ea']);
const PATH_FLAGS = new Set(['-path', '-literalpath', '-lp']);
const DEST_FLAGS = new Set(['-destination', '-dest']);

// The path arguments of one command. cmd.exe switches (/s, /q) are skipped;
// Git Bash paths (/c/Users) are kept.
function pathArgs(args) {
  const out = { paths: [], dest: null };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const low = a.toLowerCase();
    if (PATH_FLAGS.has(low)) out.paths.push(args[++i]);
    else if (DEST_FLAGS.has(low)) out.dest = args[++i];
    else if (VALUE_FLAGS.has(low)) i++;
    else if (/^-/.test(a) || /^\/[a-z?]{1,3}(?::\S*)?$/i.test(a)) continue;
    else out.paths.push(a);
  }
  out.paths = out.paths.filter(Boolean);
  return out;
}

// A path we cannot know before it runs (variables other than the home folder).
const unknowable = (t) => /[$%`]/.test(String(t).replace(/^(?:~|\$home|\$env:userprofile|%userprofile%)/i, ''));

// Where each command in the line deletes or writes, following `cd` along the way.
function assessPaths(c, ctx, add) {
  let cwd = ctx.cwd;
  let lost = false; // a cd we could not follow: relative paths after it are unknown
  for (const { raw, args } of splitCommands(c)) {
    const here = { ...ctx, cwd };
    const name = cmdName(args[0]);
    const check = (t, verb) => {
      if (!t || unknowable(t) || /^(?:\/dev\/(?:null|stdout|stderr)|nul|\$null)$/i.test(t)) return;
      const absolute = /^(?:[a-z]:|[\\/]|~)/i.test(t);
      if (lost && !absolute) return;
      const p = normPath(t, here); // resolved from where the command runs…
      const kind = secretKind(p);
      if (kind) add('high', `${verb} ${kind}`);
      else if (!inProject(p, ctx)) add('high', `${verb} outside the project`); // …judged against the project
    };

    if (CHDIR.has(name)) {
      const { paths } = pathArgs(args);
      const to = paths[0];
      if (!to || unknowable(to) || to === '-') lost = true;
      else {
        cwd = normPath(to, here);
        lost = false;
        if (!inProject(cwd, ctx)) add('medium', 'works in a folder outside the project');
      }
    } else if (DELETERS.has(name)) {
      for (const t of pathArgs(args).paths) check(t, 'deletes');
    } else if (COPIERS.has(name)) {
      const { paths, dest } = pathArgs(args);
      const target = dest || (name === 'robocopy' ? paths[1] : paths.length > 1 ? paths[paths.length - 1] : null);
      check(target, 'writes');
      if (name === 'mv' || name === 'move' || name === 'move-item' || name === 'mi') {
        for (const t of dest ? paths : paths.slice(0, -1)) check(t, 'deletes'); // moving takes it away from there
      }
    } else if (name === 'tee') {
      for (const t of pathArgs(args).paths) check(t, 'writes');
    }

    for (const t of redirectTargets(raw)) check(t, 'writes');
  }
}

function assessCommand(cmd, tool, ctx, add) {
  const raw = String(cmd || '');
  if (!raw.trim()) return;
  const c = blankMessages(raw);
  const plain = undisguise(c);
  for (const [level, reason, re] of COMMAND_RULES) if (re.test(c) || re.test(plain)) add(level, reason);
  for (const [kind, re] of SECRET_IN_COMMAND) if (re.test(c)) add('high', `touches ${kind}`);
  assessPaths(c, ctx, add);

  // A chain is two or more commands that do something. Moving into a folder of
  // the project, and piping into a filter like head or Select-Object, do not count.
  const doing = splitCommands(c).filter(({ args }, i) => {
    const name = cmdName(args[0]);
    if (i > 0 && FILTERS.has(name)) return false;
    if (CHDIR.has(name)) {
      const to = pathArgs(args).paths[0];
      return !to || unknowable(to) || !inProject(normPath(to, ctx), ctx);
    }
    return true;
  });
  if (doing.length > 1) add('medium', 'chains several commands');
  const bare = unquote(c);
  if (/\$\(/.test(bare) || (tool !== 'PowerShell' && /`/.test(bare))) add('medium', 'runs a command inside a command');
}

// A weaker reason says nothing new next to these stronger ones.
const SUPERSEDED = {
  'deletes files': ['deletes recursively', 'deletes untracked files', 'deletes outside the project'],
  'pushes to a remote': ['force-pushes'],
  'uses the network': ['runs code from the internet'],
  'runs code built from text': ['runs code from the internet'],
};

// ---- tools ----

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const QUIET_TOOLS = new Set([
  'Agent', 'Task', 'Skill', 'TodoWrite', 'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'WebSearch', 'ToolSearch',
]);

function inProject(p, ctx) {
  const root = normPath(ctx.cwd, { home: ctx.home });
  if (!root) return true; // nothing to compare with
  return within(p, root) || (ctx.extraDirs || []).some((d) => d && within(p, normPath(d, { home: ctx.home })));
}

function assess(tool, input, ctx = {}) {
  input = input && typeof input === 'object' ? input : {};
  ctx = { home: os.homedir(), ...ctx };
  let level = 'low';
  const reasons = [];
  const add = (l, r) => {
    if (RANK[l] > RANK[level]) level = l;
    if (!reasons.some((x) => x.reason === r)) reasons.push({ level: l, reason: r });
  };

  if (tool === 'Bash' || tool === 'PowerShell') {
    assessCommand(input.command, tool, ctx, add);
  } else if (WRITE_TOOLS.has(tool)) {
    const raw = input.file_path || input.notebook_path;
    if (raw) {
      const p = normPath(raw, ctx);
      const kind = secretKind(p);
      if (kind === 'Claude settings') add('high', 'changes Claude settings');
      else if (kind) add('high', `writes ${kind}`);
      if (!inProject(p, ctx)) add('high', 'writes outside the project');
      const cfg = configKind(p);
      if (cfg) add(cfg.level, cfg.reason);
    }
  } else if (READ_TOOLS.has(tool)) {
    const raw = input.file_path || input.path;
    if (raw) {
      const p = normPath(raw, ctx);
      const kind = secretKind(p);
      if (kind) add('high', `reads ${kind}`);
      else if (!inProject(p, ctx)) add('low', 'reads outside the project');
    }
  } else if (tool === 'WebFetch') {
    add('medium', 'fetches from the internet');
  } else if (/^mcp__/.test(tool || '')) {
    add('medium', 'MCP tool: unknown effect');
  } else if (!QUIET_TOOLS.has(tool)) {
    add('medium', 'unknown tool');
  }

  reasons.sort((a, b) => RANK[b.level] - RANK[a.level]);
  const shown = reasons.map((r) => r.reason).filter((r) => !(SUPERSEDED[r] || []).some((s) => reasons.some((x) => x.reason === s)));
  return { level, reasons: shown };
}

module.exports = { assess, secretKind, normPath };
