# Cloud Agent

relaymux is local-first by default. The cloud-agent path is an optional advanced topology for keeping Telegram configuration in a cloud process while repository, CLI, filesystem, and tmux actions stay inside a sandbox.

```text
Telegram
  -> Flue cloud agent
  -> authenticated sandbox hands endpoint
  -> relaymux daemon/orchestrator in the sandbox
  -> tmux child window
  -> sandbox completion callback
  -> Telegram
```

This first slice defines the boundary and generates a minimal Flue bundle. It does not deploy a hosted service and does not include a production sandbox hands server.

## Scaffold

Generate the starter bundle:

```bash
relaymux cloud scaffold --flue --out ./relaymux-cloud-agent
```

The scaffold writes:

- `flue.yml`: Flue runtime metadata with env placeholders.
- `package.json`: Node 20 smoke scripts.
- `src/cloud-agent.mjs`: Telegram webhook receiver and sandbox client.
- `README.md`: bundle-local setup notes.

Run a local syntax check:

```bash
cd ./relaymux-cloud-agent
npm install
npm run check
```

## Configuration Shape

The local relaymux config includes a disabled-by-default `cloudAgent` section:

```json
{
  "cloudAgent": {
    "enabled": false,
    "provider": "flue",
    "role": "chat",
    "telegram": {
      "botTokenEnv": "TELEGRAM_BOT_TOKEN",
      "webhookSecretEnv": "RELAYMUX_TELEGRAM_WEBHOOK_SECRET"
    },
    "sandbox": {
      "protocol": "relaymux-sandbox-hands-v1",
      "baseUrlEnv": "RELAYMUX_SANDBOX_BASE_URL",
      "authTokenEnv": "RELAYMUX_SANDBOX_TOKEN",
      "completionCallbackTokenEnv": "RELAYMUX_CLOUD_CALLBACK_TOKEN"
    }
  }
}
```

These are env var names, not secret values. Keep Telegram tokens in the cloud secret store. Keep sandbox auth tokens in both the cloud secret store and the sandbox runtime secret store.

## Sandbox Hands Protocol

The scaffold calls the sandbox with bearer auth:

```http
POST /relaymux/v1/ask
Authorization: Bearer <RELAYMUX_SANDBOX_TOKEN>
Content-Type: application/json
```

Request:

```json
{
  "protocol": "relaymux-sandbox-hands-v1",
  "operation": "ask",
  "source": "telegram",
  "text": "Open an agent in ~/code/my-app and inspect the failing tests.",
  "replyMode": "none",
  "wait": true,
  "idempotencyKey": "telegram:<chat-id>:<message-id>",
  "metadata": {
    "telegram": {
      "chatId": "<chat-id>",
      "messageId": "<message-id>",
      "updateId": "<update-id>"
    }
  }
}
```

Expected response:

```json
{
  "ok": true,
  "queued": false,
  "requestId": "sandbox-request-id",
  "reply": "Started a child agent in tmux session agents."
}
```

Future sandbox hands can also expose `operation: "launch"` for direct child-agent launches and call the cloud agent's `POST /relaymux/v1/completion` endpoint when a sandboxed `relaymux notify` event should be sent back to Telegram.

## Security Notes

- Do not expose the sandbox hands endpoint publicly without bearer auth.
- Keep the existing relaymux daemon on loopback inside the sandbox. Put any network-facing bridge in front of it with a narrow protocol.
- Do not put literal Telegram tokens, sandbox tokens, cookies, or repository secrets in config files, prompts, logs, or scaffold output.
- Use stable idempotency keys for Telegram update retries and completion retries.
- Treat the cloud agent as the chat/model process and the sandbox as the only place allowed to touch repos, CLIs, files, or tmux.

