#!/usr/bin/env node
// Plays a fake pair of agents into the running Huddle, through the real hook
// script, so you can see and click everything without starting Claude Code.

const { spawn } = require('child_process');
const path = require('path');

const hook = path.resolve(__dirname, '..', 'hooks', 'hook.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(evt, wait = false) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, wait ? [hook, 'wait'] : [hook], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('close', () => resolve(out));
    child.stdin.end(JSON.stringify(evt));
  });
}

const A = { session_id: 'demo-a', cwd: path.resolve(__dirname, '..') };
const B = { session_id: 'demo-b', cwd: path.join(path.resolve(__dirname, '..'), 'src') };
const C = { session_id: 'demo-c', cwd: path.join(path.resolve(__dirname, '..'), 'scripts') };
let n = 0;

// One subagent, from its start to its last message, the way Claude Code reports it.
async function subagent(base, description, model, message, ms) {
  const tool_use_id = `demo-${++n}`;
  const agent_id = `demo-agent-${n}`;
  const tool_input = { description, prompt: '(demo)', subagent_type: 'general-purpose', model };
  await send({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input, tool_use_id });
  await send({ ...base, hook_event_name: 'SubagentStart', agent_id, agent_type: 'general-purpose' });
  await send({
    ...base,
    hook_event_name: 'PostToolUse',
    tool_name: 'Agent',
    tool_input,
    tool_use_id,
    tool_response: { agentId: agent_id, resolvedModel: `claude-${model}`, status: 'async_launched' },
  });
  await sleep(ms);
  await send({ ...base, hook_event_name: 'SubagentStop', agent_id, agent_type: 'general-purpose', last_assistant_message: message });
}

// A third agent that works the way superpowers' subagent-driven development
// does: an implementer, a reviewer who finds a gap, a fix, the review again.
// Open its card to see the team. (No plans here: a plan could start a real
// background builder when "Build plans automatically" is on.)
async function teamDemo() {
  await send({ ...C, hook_event_name: 'SessionStart', source: 'startup' });
  await send({ ...C, hook_event_name: 'UserPromptSubmit', prompt: 'Carry out task 3 of the plan with subagents.' });
  await tool(C, 'TodoWrite', {
    todos: [
      { content: 'Task 1', status: 'completed' },
      { content: 'Task 2', status: 'completed' },
      { content: 'Task 3: retry logic', activeForm: 'Adding retry logic', status: 'in_progress' },
      { content: 'Task 4', status: 'pending' },
    ],
  }, 200);
  await subagent(C, 'Implement task 3', 'sonnet', 'Status: DONE\n\nAdded retry with backoff. 5/5 tests passing.', 2500);
  await subagent(C, 'Spec review task 3', 'opus', '❌ Issues:\n- Missing: progress reporting (the spec asks for it every 100 items)', 2500);
  await subagent(C, 'Fix spec gaps task 3', 'sonnet', 'Status: DONE\n\nAdded progress reporting.', 2500);
  await subagent(C, 'Spec review task 3', 'opus', '✅ Spec compliant: all requirements met.', 2500);
  await send({ ...C, hook_event_name: 'Stop', last_assistant_message: 'Task 3 is done and reviewed.' });
}

async function tool(base, tool_name, tool_input, ms = 700) {
  const tool_use_id = `demo-${++n}`;
  await send({ ...base, hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id });
  await sleep(ms);
  await send({ ...base, hook_event_name: 'PostToolUse', tool_name, tool_input, tool_use_id, duration_ms: ms });
}

(async () => {
  console.log('The huddle stays hidden while you are in this window, since the fake agents "run" here.');
  console.log('Click the desktop or another app now to see it. Starting in 4 seconds…');
  await sleep(4000);
  await send({ ...A, hook_event_name: 'SessionStart', source: 'startup' });
  await send({ ...B, hook_event_name: 'SessionStart', source: 'startup' });
  await send({ ...A, hook_event_name: 'UserPromptSubmit', prompt: 'Add a dark mode toggle to the settings page.' });
  await send({ ...B, hook_event_name: 'UserPromptSubmit', prompt: 'Why is the build slow?' });
  const team = teamDemo(); // runs alongside the other two

  await tool(A, 'Grep', { pattern: 'theme' });
  await tool(A, 'Read', { file_path: 'C:\\app\\src\\settings\\Settings.tsx' });
  await tool(B, 'Bash', { command: 'npm run build -- --profile', description: 'Profile the build' }, 1200);
  await tool(A, 'Edit', { file_path: 'C:\\app\\src\\settings\\Settings.tsx', old_string: 'a', new_string: 'b' });

  console.log('Agent A is asking for permission. Answer it in the huddle…');
  const cmd = { command: 'npm install next-themes', description: 'Install next-themes' };
  await send({ ...A, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: cmd, tool_use_id: 'demo-perm' });
  const decision = await send({ ...A, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: cmd }, true);
  console.log('Hook output:', decision || '(none: falls back to the VS Code prompt)');

  console.log('Agent A wants to edit a file. Note the diff, then answer…');
  const edit = {
    file_path: path.join(A.cwd, 'src', 'settings.js'),
    old_string: "const theme = 'light';\nexport function toggle() {}",
    new_string: "import { useTheme } from 'next-themes';\nconst theme = useTheme();\nexport function toggle() {\n  theme.set(theme.dark ? 'light' : 'dark');\n}",
  };
  console.log('Hook output:', (await send({ ...A, hook_event_name: 'PermissionRequest', tool_name: 'Edit', tool_input: edit }, true)) || '(none)');

  console.log('Agent B wants to run something risky. Note the red label…');
  const risky = { command: 'git reset --hard && rm -rf dist', description: 'Start over from the last commit' };
  console.log('Hook output:', (await send({ ...B, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: risky }, true)) || '(none)');

  console.log('Agent B is asking a question. Answer it in the huddle…');
  const answer = await send(
    {
      ...B,
      hook_event_name: 'PermissionRequest',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            question: 'Which bundler should I switch to?',
            header: 'Bundler',
            multiSelect: false,
            options: [
              { label: 'Vite', description: 'Fast dev server, simple config' },
              { label: 'Keep webpack', description: 'Just tune the current setup' },
            ],
          },
        ],
      },
    },
    true
  );
  console.log('Hook output:', answer || '(none: falls back to the VS Code prompt)');

  await send({ ...A, hook_event_name: 'Stop', last_assistant_message: 'Dark mode toggle added to Settings.' });
  await send({ ...B, hook_event_name: 'Stop', last_assistant_message: 'The build is slow because of source maps.' });
  await team;
  console.log('Done. The demo agents disappear by themselves within ten seconds.');
})();
