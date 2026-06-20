# relaymux

`relaymux` is a lightweight metaharness for coding agents.

Telegram or iMessage can be the remote control / orchestrator. The agent work runs through an explicit execution backend.

Current execution backends:

- `local-tmux`: opens a visible local `tmux` window/tab. This is the default and preserves existing relaymux behavior.
- `local-background`: starts a detached local process and writes stdout/stderr logs under the relaymux state directory.
- `cloud-sandbox`: reserved for cloud agent/sandbox adapters. It fails closed unless an explicit provider adapter is configured.

## Requirements

You need Node.js 20+, npm, and a local agent CLI such as `pi`, `codex`, or `claude`.

`tmux` is required for the default `local-tmux` executor. It is not required for `local-background`.

SQLite support uses the system `sqlite3` CLI for `relaymux db` commands; normal launch, status, notify, and adapter commands do not require it.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/mupt-ai/relaymux/main/install.sh | bash
```

## Quickstart

Create a bot with [BotFather](https://t.me/BotFather), copy the token, then run:

```bash
relaymux setup --telegram --telegram-bot-token '<telegram-bot-token>'
```

When prompted, open your bot in Telegram and send `/start`. relaymux will automatically start the background service.

Check it:

```bash
relaymux status
```

Send your Telegram bot a message like:

```text
Open an agent in ~/code/my-app and inspect the failing tests.
```

relaymux passes the message to your configured local orchestrator. If the orchestrator launches an agent without choosing an executor, that agent still runs in `tmux`; the final reply comes back through Telegram.

Manual notification test:

```bash
relaymux notify --from test --reply-mode telegram --message "hello from relaymux"
```

## Execution Backends

relaymux launch has an explicit executor:

```bash
relaymux launch \
  --repo ~/code/my-app \
  --agent pi \
  --name inspect-tests \
  --prompt "Inspect the failing tests and summarize what is broken." \
  --executor local-tmux
```

`--mode` is accepted as an alias for `--executor`. Valid executors are `local-tmux`, `local-background`, and `cloud-sandbox`.

`--group <name>` groups runs. For `local-tmux`, the group becomes the tmux session when `--session` is not provided. Existing `--session` and `--session-mode shared|per-worktree` behavior remains supported.

Agent names are resolved from `config.agents`. Defaults include `pi`, `codex`, `claude`, and `custom`; `cc` aliases to `claude` unless you define an explicit `agents.cc` entry.

## local-tmux

`local-tmux` is the compatibility default. relaymux uses one shared `tmux` session named `agents` by default. Each launched agent gets its own tmux window. Telegram starts and receives updates from work, but tmux keeps that work visible and recoverable locally.

Attach any time:

```bash
tmux attach -t agents
```

Detach with `Ctrl-b d`. Closing Telegram does not stop the tmux run.

## local-background

`local-background` starts the same relaymux wrapper script as a detached process. The run is recorded in relaymux state, and stdout/stderr logs are written under:

```text
<stateDir>/logs/<runId>.out.log
<stateDir>/logs/<runId>.err.log
```

Example:

```bash
relaymux launch \
  --repo ~/code/my-app \
  --agent codex \
  --name inspect-tests-bg \
  --prompt "Inspect the failing tests and summarize what is broken." \
  --executor local-background \
  --group test-runs
```

`relaymux status` shows local-background runs without requiring `--history`, including pid target, lifecycle state, last event, and log path.

## cloud-sandbox

`cloud-sandbox` is an adapter boundary for future cloud agent providers. It does not fake a local launch. If `execution.cloudSandbox.provider` and `execution.cloudSandbox.command` are not configured, relaymux exits with a clear error.

Config shape:

```json
{
  "execution": {
    "defaultExecutor": "local-tmux",
    "cloudSandbox": {
      "provider": "",
      "command": [],
      "env": {}
    }
  }
}
```

## Launch an agent manually

```bash
relaymux launch \
  --repo ~/code/my-app \
  --agent pi \
  --name inspect-tests \
  --prompt "Inspect the failing tests and summarize what is broken."
```

Then attach with:

```bash
tmux attach -t agents
```

That command still defaults to `local-tmux`.
