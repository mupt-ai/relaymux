# relaymux

`relaymux` is a lightweight local metaharness for coding agents. Telegram is the remote control; `tmux` is where the actual agent work happens.

The background service listens for Telegram messages, but it does not hide agent runs in a black box. When relaymux launches an agent, it opens a visible `tmux` window on your machine so you can attach, watch, interrupt, or debug the run like any normal terminal session.

Telegram is the main supported interface. iMessage/SMS support exists, but it is beta.

## Requirements

You need Node.js 20+, npm, git, tmux, and a local agent CLI such as `pi`, `codex`, or `claude`.

## Install

```bash
git clone https://github.com/mupt-ai/relaymux.git
cd relaymux
./install.sh
export PATH="$HOME/.local/bin:$PATH"
```

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

iMessage/SMS depends on a working local `imsg` command. The minimal setup is:

```bash
relaymux setup --imsg
```

relaymux will try to show recent chats. Pick one, then text that chat to use relaymux. If chat discovery does not work, pass the chat id directly:

```bash
relaymux setup --imsg --chat-id '<chat-id-or-phone-number>'
```

## Troubleshooting

```bash
relaymux doctor
relaymux status-launch-agent
relaymux status --history
```

Logs live in `~/.relaymux/logs`. Config lives at `~/.relaymux/config.json`.
