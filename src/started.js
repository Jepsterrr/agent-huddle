// Notices that a command we hold a permission prompt for has started anyway:
// the user said yes in the editor's own dialog. Claude Code does not stop our
// waiting hook when that happens, and the tool's PostToolUse only arrives when
// the command finishes, so a long-running command would otherwise leave its
// Allow/Deny buttons in the huddle the whole time it runs.
//
// The sign: Claude Code starts a shell for every Bash or PowerShell call, as a
// direct child of its own process (bash.exe, or cmd.exe -> powershell.exe on
// Windows, measured on 2.1.322). Shell children that already existed when the
// prompt appeared are ignored; a new one only counts once it has been alive for
// 0.9 s, which rules out the status line bridge and short shell-form hooks. Commands from the same session that are running in
// parallel are counted out.
//
// Known limits: a parallel `run_in_background` command started while the
// prompt waits, or a subagent's command, can look like the prompt's own
// command; the card is then released early (Claude Code still asks in the
// editor, so nothing is lost but the huddle's buttons for that prompt).

const SHELLS = new Set(['bash.exe', 'sh.exe', 'zsh.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'bash', 'sh', 'zsh']);
const isShell = (name) => SHELLS.has(String(name || '').toLowerCase());
const LASTING_MS = 900; // the status line bridge lives ~0.1 s; a real command that ends sooner gets PostToolUse anyway

class StartWatch {
  constructor() {
    this.track = new Map(); // pendingId -> { baseline: Set<pid>, firstSeen: Map<pid, ms> }
  }

  // children: [{ pid, name }] of the session's Claude Code process, now.
  // otherRunning: commands of this session already running that are not waiting on a prompt.
  // Returns true when the prompt's own command has evidently started.
  check(pendingId, children, otherRunning = 0, now = Date.now()) {
    const shells = children.filter((c) => isShell(c.name));
    const t = this.track.get(pendingId);
    if (!t) {
      this.track.set(pendingId, { baseline: new Set(shells.map((c) => c.pid)), firstSeen: new Map() });
      return false;
    }
    const fresh = new Set();
    for (const c of shells) {
      if (t.baseline.has(c.pid)) continue;
      fresh.add(c.pid);
      if (!t.firstSeen.has(c.pid)) t.firstSeen.set(c.pid, now);
    }
    for (const pid of [...t.firstSeen.keys()]) if (!fresh.has(pid)) t.firstSeen.delete(pid); // it ended
    const lasting = [...t.firstSeen.values()].filter((at) => now - at >= LASTING_MS).length;
    return lasting > Math.max(0, otherRunning);
  }

  // Forget prompts that are no longer waiting.
  keep(pendingIds) {
    const live = new Set(pendingIds);
    for (const id of [...this.track.keys()]) if (!live.has(id)) this.track.delete(id);
  }
}

module.exports = { StartWatch, isShell };
