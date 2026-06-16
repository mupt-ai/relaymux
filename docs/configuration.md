# Configuration

`relaymux init` writes a core config with no message adapters at `~/.relaymux/config.json`. The file is private by default and relaymux refuses to overwrite it unless you pass `--force`.

relaymux stores private config, run records, prompts, logs, and local API token state under `~/.relaymux` by default:

```text
~/.relaymux/
  config.json     # private config, written mode 0600
  state/          # run records, prompts, scripts, schedules, daemon state, local API token
  logs/           # background service stdout/stderr logs
  tasks/          # optional task scratch space
  reports/        # optional reports
  research/       # optional research notes
```

## Core Config

Command arrays are argv templates. `{prompt}` and `{promptFile}` are substituted at launch time. The Pi commands below are examples, not requirements; edit them to match the agent CLIs you actually use.

```json
{
  "version": 1,
  "session": "agents",
  "stateDir": "~/.relaymux/state",
  "tmux": {
    "sessionMode": "shared"
  },
  "daemon": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 47761,
    "tokenFile": "~/.relaymux/state/webhook-token",
    "launchAgentLabel": "com.relaymux.daemon",
    "watchdog": {
      "enabled": true,
      "intervalSeconds": 60
    },
    "logDir": "~/.relaymux/logs"
  },
  "integrations": {},
  "orchestrator": {
    "cwd": "~",
    "command": ["pi", "--print", "--continue", "--session-dir", "~/.relaymux/state/sessions", "{prompt}"],
    "promptMode": "arg",
    "defaultSystemPrompt": true,
    "systemPromptFile": "",
    "extraSystemPrompt": ""
  },
  "agents": {
    "pi": { "command": ["pi", "{prompt}"], "promptMode": "arg" },
    "codex": { "command": ["codex", "{prompt}"], "promptMode": "arg" },
    "custom": { "command": ["sh", "-lc", "printf '%s\\n' \"$RELAYMUX_PROMPT\""], "promptMode": "env" }
  }
}
```

`daemon.launchAgentLabel` names the macOS LaunchAgent. On Linux the same value is reused as the systemd user service name with a `.service` suffix unless you set `daemon.systemdServiceName`.

## Agents And Orchestrator

An agent is a command template in `~/.relaymux/config.json`. If you configure `pi`, relaymux runs `pi ...`; if you configure `codex`, it runs `codex ...`; if you configure `custom`, it can be any shell command.

The orchestrator is also a command, but it has a different job from an agent. The orchestrator handles inbound requests from `relaymux ask` or optional message adapters. Agents do delegated work launched with `relaymux launch`. The orchestrator receives incoming text plus relaymux instructions and prints a reply on stdout.

relaymux owns the generic orchestrator operating instructions in the source repo. By default, every orchestrator request includes those repo-managed instructions: stay local-first, be concise, delegate work that may take more than about 2 minutes with `relaymux launch`, use the configured shared tmux session, prefer prompt files for longer delegated tasks, ask subagents to call `relaymux notify` with idempotency keys, keep quiet updates on `--reply-mode none`, use `relaymux schedule` for recurring prompts, inspect real tmux/repo/test state before claiming completion, and never put secrets in prompts, logs, PRs, or replies.

Inline handling is meant for quick routing, read-only inspection, tiny personal-file edits, quick answers, or explicit user requests to stay inline. Repo code changes, PR fixes, debugging/deploy work, deep research, CI loops, docs rewrites, long validation, and multi-file edits should normally become visible relaymux subagent runs.

Your config owns local details: adapter tokens and chat IDs, exact agent CLI commands, local working directories, session names, private preferences, and repo-specific overrides. `orchestrator.systemPromptFile` and `orchestrator.extraSystemPrompt` are additive escape hatches for those local preferences; they are not required for best-practice operation. Set `orchestrator.defaultSystemPrompt` to `false` only if you want to fully replace relaymux's repo-managed orchestration guidance.

Example local override:

```json
{
  "orchestrator": {
    "defaultSystemPrompt": true,
    "systemPromptFile": "~/.relaymux/orchestrator.local.md",
    "extraSystemPrompt": "Use the custom agent first for documentation-only requests."
  }
}
```

## Prompt Passing

If a command contains `{prompt}` or `{promptFile}`, relaymux substitutes those values. Agent command templates can also use run context such as `{agent}`, `{name}`, `{repo}`, `{workdir}`, `{runId}`, and `{session}`. If the command does not contain a prompt placeholder, `promptMode` decides what to do with the prompt:

| `promptMode` | Behavior |
| --- | --- |
| `arg` | Append the prompt as a command-line argument unless `{prompt}` is already present. |
| `env` | Put the prompt in `RELAYMUX_PROMPT`. |
| `stdin` | Write the prompt under `~/.relaymux/state/prompts` and pipe that file to stdin. |
| `none` | Do not pass the prompt automatically. |

Use `--prompt @prompt.txt` or `--prompt-file prompt.txt` for longer prompts.

## Tmux Sessions

A run is one `relaymux launch`. By default, relaymux creates a new tmux window in one shared session named `agents`. tmux calls these windows; many terminal apps display them like tabs. relaymux does not create panes or splits for agent runs.

Launch a named agent in the default shared session:

```bash
relaymux launch --repo ~/code/my-app --agent pi --name fix-api --prompt @prompt.txt
```

Launch into a separate tmux session when you want an isolated group of windows:

```bash
relaymux launch --session release-fix --repo ~/code/my-app --agent codex --prompt @prompt.txt
```

Use per-worktree sessions when each Git worktree should get a stable session name. In this mode, relaymux derives the session from the repo/worktree/branch plus a short hash:

```bash
relaymux launch --session-mode per-worktree --repo ~/code/my-app --agent pi --prompt @prompt.txt
```

Inspect local state. `--history` includes old run records whose tmux windows have already exited:

```bash
relaymux status
relaymux status --history
relaymux status --session agents
```
