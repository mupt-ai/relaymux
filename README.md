# relaymux

`relaymux` lets you text a local Pi orchestrator over iMessage/SMS. The orchestrator can open coding-agent tabs in `tmux`, keep track of them, and send short status updates back to the chat.

It is local-first and repo-agnostic: you bring your own Pi command, message send/receive command, and agent commands.

## Install

Install with the standalone shell installer:

```bash
curl -fsSL https://raw.githubusercontent.com/avyayv/relaymux/main/install.sh | bash
relaymux init --imsg
```

Or from this checkout:

```bash
./install.sh
relaymux init --imsg
```

The installer builds relaymux locally and writes a shim to `~/.local/bin/relaymux`. It requires `node`, the project build tooling, and `git` when installing via curl.

The imsg setup finds your local `imsg` and `pi` commands, prompts for the Messages chat to use, and writes:

```text
~/.config/relaymux/config.json
```

If you already know the chat id, skip the prompt:

```bash
relaymux init --imsg --chat-id 1
```

`imsg` is the built-in preset. You can still edit the config later to use a different message CLI, as long as receive prints JSON/JSONL messages and send accepts `{text}`.

## Run it

Check your setup:

```bash
relaymux doctor
```

Run the daemon in the foreground:

```bash
relaymux daemon
```

Install it as a macOS LaunchAgent:

```bash
relaymux install-launch-agent
```

Remove it later:

```bash
relaymux uninstall-launch-agent
```

## Open agent tabs manually

```bash
relaymux launch \
  --repo ~/code/my-app \
  --agent pi \
  --name fix-api \
  --prompt "Fix the API bug, run tests, and report back with relaymux notify."
```

See running tabs:

```bash
relaymux status
```

Attach to the tmux session:

```bash
tmux attach -t agents
```

## Report back from a subagent

A subagent can send a completion update to the local daemon:

```bash
relaymux notify \
  --from fix-api \
  --reply-mode imessage \
  --idempotency-key fix-api-done \
  --message "Fixed the API bug. Tests pass."
```

Use `--reply-mode none` for quiet context that should not text the user.

## Test without sending messages

The mock config uses no real iMessage commands:

```bash
npm run build
rm -rf /tmp/relaymux-mock
node ./dist/bin/relaymux.js --config examples/config.mock.json daemon
```

In another terminal:

```bash
node ./dist/bin/relaymux.js --config examples/config.mock.json notify \
  --from smoke \
  --reply-mode imessage \
  --idempotency-key smoke-1 \
  --message "Smoke test complete"

cat /tmp/relaymux-mock/outbox.txt
```

## Notes

`relaymux` does not include private prompts, phone numbers, secrets, or repo-specific context. The completion webhook binds to localhost and uses a token file. There is no durable `/loop` feature.
