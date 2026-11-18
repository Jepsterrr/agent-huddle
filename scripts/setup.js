#!/usr/bin/env node
// Finishes the Claude Code plugin install. Run by /agent-huddle:setup, never
// by itself.
//
// Claude Code installs the plugin's npm packages without running their install
// scripts, and Electron fetches its binary in one. So this downloads the
// Electron runtime into the plugin's data folder (--data, ${CLAUDE_PLUGIN_DATA}),
// which survives plugin updates (about 100 MB, once per Electron version), and
// then starts the app. It changes nothing in the user's settings: the quota
// figures come through the plugin's own module (hooks/huddle-mod.ts).
//
//   node scripts/setup.js --data <dir>

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const data = argv.includes('--data') ? argv[argv.indexOf('--data') + 1] : '';
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`Agent Huddle setup: ${msg}`);
  process.exit(1);
}

if (!data || data.includes('${')) fail('run this through /agent-huddle:setup (the plugin data folder is missing).');
fs.mkdirSync(data, { recursive: true });

const pkgDir = path.join(root, 'node_modules', 'electron');
let version = '';
try {
  version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
} catch {
  fail("the plugin's packages are missing. Run `claude plugin update agent-huddle`, then this setup again.");
}
const target = path.join(data, `electron-${version}`);
const exeRel = () => {
  try {
    return fs.readFileSync(path.join(target, 'path.txt'), 'utf8').trim();
  } catch {
    return '';
  }
};
const haveElectron = () => !!exeRel() && fs.existsSync(path.join(target, 'dist', exeRel()));

if (haveElectron()) {
  console.log(`Electron ${version} is already set up.`);
} else {
  console.log(`Downloading Electron ${version} (about 100 MB, once)…`);
  // Run Electron's own installer from a copy of its package in the data
  // folder, so the binary lands there. Its helpers are found through NODE_PATH.
  fs.mkdirSync(target, { recursive: true });
  for (const f of fs.readdirSync(pkgDir)) {
    const from = path.join(pkgDir, f);
    if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(target, f));
  }
  try {
    fs.unlinkSync(path.join(target, 'path.txt')); // written again once the download is in place
  } catch {}
  const env = { ...process.env };
  env.NODE_PATH = [path.join(pkgDir, 'node_modules'), path.join(root, 'node_modules'), env.NODE_PATH]
    .filter(Boolean)
    .join(path.delimiter);
  const r = spawnSync(process.execPath, [path.join(target, 'install.js')], { cwd: target, env, stdio: 'inherit' });
  if (r.status !== 0 || !haveElectron()) fail('the Electron download did not finish. Check the network and run setup again.');
  console.log('Electron is set up.');
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // set inside VS Code; would make Electron act as plain Node
spawn(path.join(target, 'dist', exeRel()), [root], { cwd: root, env, detached: true, stdio: 'ignore', windowsHide: true }).unref();
console.log('Agent Huddle is running. From now on it starts by itself with your first Claude Code session.');
