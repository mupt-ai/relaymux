# relaymux

`relaymux` is a lightweight local metaharness for coding agents. Telegram is the remote control; `tmux` is where the actual agent work happens.

The background service listens for Telegram messages, but it does not hide agent runs in a black box. When relaymux launches an agent, it opens a visible `tmux` window on your machine so you can attach, watch, interrupt, or debug the run like any normal terminal session.

Telegram is the main supported interface. iMessage/SMS support exists, but it is beta.

## Requirements

You need Node.js 20+, npm, `tmux`, and a local agent CLI such as `pi`, `codex`, or `claude`. The installer uses `curl` and `tar` by default; it only needs `git` as a fallback. SQLite support uses the system `sqlite3` CLI for `relaymux db` commands; normal launch, status, notify, and adapter commands do not require it.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/mupt-ai/relaymux/main/install.sh | bash
```

The installer downloads a source tarball, builds relaymux locally, and writes the CLI shim into a writable directory already on your `PATH` when possible. You do not need to clone the repo.

## Set up Telegram

Create a bot with [BotFather](https://t.me/BotFather), copy the token, then run:

```bash
relaymux setup --telegram --telegram-bot-token '<telegram-bot-token>'
```

When prompted, open your bot in Telegram and send `/start`. relaymux stores the token in `~/.relaymux/secrets/telegram-bot-token`, discovers your chat id, writes `~/.relaymux/config.json`, and starts the background service.

Check it:

```bash
relaymux status
```

## Use it

Send your Telegram bot a message like:

```text
Open an agent in ~/code/my-app and inspect the failing tests.
```

relaymux passes the message to your configured local orchestrator. If the orchestrator launches an agent, that agent runs in `tmux`; the final reply comes back through Telegram.

Manual notification test:

```bash
relaymux notify --from test --reply-mode telegram --message "hello from relaymux"
```

## tmux is the workspace

relaymux uses one shared `tmux` session named `agents` by default. Each launched agent gets its own tmux window. This is the core idea: Telegram starts and receives updates from work, but tmux keeps that work visible and recoverable locally.

Attach any time:

```bash
tmux attach -t agents
```

Detach with `Ctrl-b d`. Closing Telegram does not stop the tmux run.

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

## iMessage/SMS beta

iMessage/SMS depends on a working local [`imsg`](https://github.com/openclaw/imsg) command. The minimal setup is:

```bash
relaymux setup --imsg
```

relaymux will try to show recent chats. Pick one, then text that chat to use relaymux. If chat discovery does not work, pass the chat id directly:

```bash
relaymux setup --imsg --chat-id '<chat-id-or-phone-number>'
```

Inbound iMessage/SMS handling is restricted to the configured chat id. The receive command must be scoped with `{chatId}`; if command output includes a chat, conversation, or thread id, relaymux only accepts messages whose id exactly matches the configured chat. Older command output without an explicit chat id is accepted only when the receive command is scoped this way.

## Troubleshooting

```bash
relaymux doctor
relaymux status-launch-agent
relaymux status --history
```

Logs live in `~/.relaymux/logs`. Config lives at `~/.relaymux/config.json`.

relaymux also owns a first-party SQLite database at `~/.relaymux/relaymux.sqlite3` by default. Initialize or inspect it with:

```bash
relaymux db path
relaymux db init
relaymux db status
```
