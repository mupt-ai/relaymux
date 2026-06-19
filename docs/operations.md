# Operations

This page covers background service behavior, safety, troubleshooting, and development commands.

## Install Footprint

The install script builds relaymux locally, writes app files under `~/.local/lib/relaymux`, and writes a `relaymux` shim under `~/.local/bin` unless you override the install directories. Service files are created only when you run setup/restart: `~/Library/LaunchAgents` on macOS or `~/.config/systemd/user` (or `$XDG_CONFIG_HOME/systemd/user`) on Linux.

Stop the background service and remove the installed binary:

```bash
relaymux uninstall-launch-agent
rm -rf ~/.local/lib/relaymux ~/.local/bin/relaymux
```

Optionally remove local state, config, and the relaymux SQLite database after checking for data you want to keep:

```bash
rm -rf ~/.relaymux
```

## Background Service

The daemon is optional for local launches, but useful for the local API and adapter delivery. `relaymux setup`, `relaymux install-launch-agent`, and `relaymux restart-launch-agent` install the per-user background service for the current platform. The command names are kept for CLI compatibility: macOS uses a launchd LaunchAgent, while Linux uses a systemd user service (`systemctl --user`). The daemon runs outside tmux.

```bash
relaymux restart-launch-agent
relaymux status-launch-agent
relaymux uninstall-launch-agent
```

On macOS, `restart-launch-agent` writes two LaunchAgents: the main relaymux daemon and a small watchdog. The watchdog runs once a minute, checks the daemon's launchd state plus `/health` on the local API, and bootstraps or kickstarts the daemon if it was killed or left unloaded. Use `--no-watchdog` only when you intentionally want to manage recovery yourself.

On Linux, `restart-launch-agent` writes `~/.config/systemd/user/<service>.service` (or `$XDG_CONFIG_HOME/systemd/user/<service>.service`) and runs `systemctl --user daemon-reload`, `systemctl --user enable <service>`, and `systemctl --user restart <service>`. The unit uses `Restart=always`, so no separate watchdog unit is installed. If `systemctl --user` cannot connect to a user bus, run `relaymux daemon` in the foreground or enable user services for the account (for example, a real systemd login session and, on headless servers, `loginctl enable-linger "$USER"`).

Turn on wrapper-level exit notifications if you want a fallback even when the agent forgets to call `relaymux notify`. `failure` means only nonzero exits notify; `always` also notifies on success; `never` is the default:

```bash
relaymux launch --repo ~/code/my-app --agent pi --name risky-task \
  --notify-on-exit failure --notify-reply-mode telegram \
  --prompt @prompt.txt
```

Adapter exit notifications require the daemon and the selected adapter. Local `started` and `completed` run events are still recorded without them.

## Safety Model And Limitations

relaymux is designed for a single user's local machine. The daemon binds to `127.0.0.1` and API requests authenticate with a random token stored under `~/.relaymux/state`. The config file is written with private file permissions.

That does not make arbitrary agents safe. If a local request or adapter message causes your orchestrator to launch `pi`, `codex`, `claude`, or a shell script, that command has the same local permissions it would have if you ran it yourself. Configure relaymux only with adapters and agents you trust, review your agent prompts, and assume prompts, logs, tmux scrollback, and run records may contain sensitive project context.

relaymux is probably the wrong tool if you need a sandbox, a multi-tenant service, durable distributed jobs, a hosted scheduler, hosted model inference, or a web UI. `relaymux schedule` is only a local OS scheduler wrapper for simple recurring prompts. relaymux is also not a general iMessage, SMS, or Telegram library.

## Troubleshooting

If setup says the background service is not running, reload it from a normal terminal:

```bash
relaymux restart-launch-agent
relaymux status-launch-agent
```

A healthy macOS install should show both the main LaunchAgent and `Watchdog ... loaded`. The checked-in watchdog script is copied to `~/.relaymux/bin/<launch-agent-label>-watchdog.sh`, and its plist lives at `~/Library/LaunchAgents/<launch-agent-label>.watchdog.plist`. Watchdog activity is logged under `~/.relaymux/logs/launch-agent-watchdog.log`.

A healthy Linux install should show `systemd user service ... active`. If it does not, inspect it with:

```bash
systemctl --user status com.relaymux.daemon.service
journalctl --user -u com.relaymux.daemon.service -e
```

If `systemctl --user` reports that it cannot connect to the bus, use a normal systemd user login session, check `XDG_RUNTIME_DIR`, or enable lingering for the account on a headless machine. As a temporary fallback, run `relaymux daemon` in a foreground shell.

If iMessage/SMS send or receive fails, verify your `imsg` CLI first:

```bash
imsg chats --limit 5 --json
relaymux doctor
```

You may need to grant the terminal or automation host the macOS permissions required by your message tool, such as Full Disk Access or Messages automation permission.

Daemon logs include compact latency lines for debugging slow turns:

```text
latency job_done type=incoming requestId=... queueWaitMs=12 orchestratorMs=9040 adapterSendMs=520 totalMs=9568
latency poll adapter=imessage durationMs=1180 messages=20 fresh=1 queueLength=1 processing=true
```

The latency lines intentionally include ids, durations, adapter names, and queue counts, but not prompt text, adapter message text, chat ids, tokens, or secrets.

If Telegram sending fails, verify the chat id, token source, and token file permissions:

```bash
chmod 600 ~/.relaymux/secrets/telegram-bot-token
relaymux doctor
```

If tmux is missing, install it with your OS package manager:

```bash
# macOS
brew install tmux

# Debian/Ubuntu
sudo apt-get install tmux

relaymux doctor
```

If the notify token has loose permissions:

```bash
chmod 600 ~/.relaymux/state/webhook-token
relaymux doctor
```

If you want to initialize or inspect the first-party SQLite store:

```bash
relaymux db path
relaymux db init
relaymux db status
relaymux db schema
```

`relaymux db init` and live DB status checks require the system `sqlite3` CLI. `relaymux doctor` reports whether it is available, but missing SQLite is warning-only unless you run a DB command.

For a no-adapter smoke test from a clone:

```bash
npm run build
rm -rf /tmp/relaymux-mock
node ./dist/bin/relaymux.js --config examples/config.mock.json daemon --once
node ./dist/bin/relaymux.js --config examples/config.mock.json launch \
  --repo /tmp/relaymux-mock/repo --agent custom --name smoke --prompt "smoke"
node ./dist/bin/relaymux.js --config examples/config.mock.json status --history
```

## Development

```bash
npm ci
npm run validate
```

Please keep public examples free of private paths, phone numbers, chat ids, tokens, and secrets.
