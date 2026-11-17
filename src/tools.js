// Turns a tool call into something a human can read at a glance.

const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

const base = (p) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() || '';

const host = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return String(url ?? '');
  }
};

// Short one-line summary for the step list.
function describe(tool, input = {}) {
  input = input || {};
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return { title: clip(input.description || 'Run command', 120), detail: clip(input.command, 2000) };
    case 'Read':
      return { title: `Read ${base(input.file_path)}`, detail: input.file_path || '' };
    case 'Edit':
    case 'MultiEdit':
      return { title: `Edit ${base(input.file_path)}`, detail: input.file_path || '' };
    case 'Write':
      return { title: `Write ${base(input.file_path)}`, detail: input.file_path || '' };
    case 'NotebookEdit':
      return { title: `Edit notebook ${base(input.notebook_path)}`, detail: input.notebook_path || '' };
    case 'Glob':
      return { title: 'Find files', detail: clip(input.pattern, 300) };
    case 'Grep':
      return { title: 'Search code', detail: clip(input.pattern, 300) };
    case 'WebFetch':
      return { title: `Fetch ${host(input.url)}`, detail: clip(input.url, 500) };
    case 'WebSearch':
      return { title: 'Search the web', detail: clip(input.query, 300) };
    case 'Agent':
    case 'Task':
      return {
        title: `Start subagent${input.subagent_type ? ` (${input.subagent_type})` : ''}`,
        detail: clip(input.description || input.prompt, 500),
      };
    case 'TodoWrite':
      return { title: 'Update todo list', detail: '' };
    case 'AskUserQuestion':
      return { title: 'Ask you a question', detail: clip(input.questions?.[0]?.question, 300) };
    case 'ExitPlanMode':
      return { title: 'Present plan', detail: clip(input.plan, 500) };
    case 'Skill':
      return { title: `Use skill ${input.skill || ''}`.trim(), detail: clip(input.args, 300) };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool || '');
      const title = mcp ? `${mcp[1]}: ${mcp[2]}` : String(tool || 'Tool');
      return { title: clip(title, 120), detail: clip(json(input), 500) };
    }
  }
}

// Fuller body shown when the agent asks for permission.
function permissionDetail(tool, input = {}) {
  input = input || {};
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return clip(input.command, 4000);
    case 'Edit':
      return clip(
        `${input.file_path}\n\n` +
          prefix(clip(input.old_string, 1200), '- ') +
          '\n' +
          prefix(clip(input.new_string, 1200), '+ '),
        4000
      );
    case 'Write':
      return clip(`${input.file_path}\n\n${clip(input.content, 2500)}`, 4000);
    case 'WebFetch':
      return clip(`${input.url}\n\n${input.prompt || ''}`.trim(), 2000);
    default:
      return clip(json(input), 3000);
  }
}

const WHERE = {
  session: 'for this session',
  localSettings: 'in this project',
  projectSettings: 'in this project (shared settings)',
  userSettings: 'in all projects',
};
const MODES = { acceptEdits: 'Accept all file edits', auto: 'Switch to auto mode', dontAsk: "Don't ask again" };

// Says in plain words what "Always allow" would change, from the permission
// updates Claude Code suggests. Returns '' when there is nothing we can
// describe faithfully, in which case the button is not offered.
function describeSuggestions(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const lines = [];
  for (const s of list) {
    const where = WHERE[s?.destination] || '';
    if (s?.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules) && s.rules.length) {
      const rules = s.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName));
      lines.push(`Allow ${rules.join(', ')} ${where}`.trim());
    } else if (s?.type === 'setMode' && MODES[s.mode]) {
      lines.push(`${MODES[s.mode]} ${where}`.trim());
    } else if (s?.type === 'addDirectories' && Array.isArray(s.directories) && s.directories.length) {
      lines.push(`Allow access to ${s.directories.join(', ')} ${where}`.trim());
    } else {
      return '';
    }
  }
  return clip(lines.join('\n'), 600);
}

const prefix = (text, p) => String(text).split('\n').map((l) => p + l).join('\n');

function json(v) {
  try {
    const s = JSON.stringify(v, null, 2);
    return s === '{}' ? '' : s;
  } catch {
    return '';
  }
}

module.exports = { describe, permissionDetail, describeSuggestions, clip, base };
