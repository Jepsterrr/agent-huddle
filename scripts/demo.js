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
let n = 0;

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
  console.log('Done. The demo agents disappear by themselves within ten seconds.');
})();
