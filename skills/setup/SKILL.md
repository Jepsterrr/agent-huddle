---
description: Set up the Agent Huddle app after installing the plugin (downloads the Electron runtime once and starts the app).
disable-model-invocation: true
---

Run exactly this one command with the Bash tool (or PowerShell tool), then tell the user in two or three plain sentences what it reported. Do not run anything else.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.js" --data "${CLAUDE_PLUGIN_DATA}"
```

Setup downloads the Electron runtime (about 100 MB) the first time, which can take a minute or two; use a timeout of at least 5 minutes. If it fails, show the user the last lines of its output as they are.
