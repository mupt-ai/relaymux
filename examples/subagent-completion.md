# Subagent completion examples

Ask delegated agents to report completion through `relaymux notify` instead of sending adapter messages directly.

Quiet context-only update (works without any message adapter):

```bash
relaymux notify \
  --from build-agent \
  --reply-mode none \
  --idempotency-key "build-agent:job-123:checkpoint-1" \
  --message "Still running tests; no user-visible update needed yet."
```

User-visible completion through an optional adapter:

```bash
relaymux notify \
  --from build-agent \
  --reply-mode imessage \
  --idempotency-key "build-agent:job-123:done" \
  --message "Finished the build fix. Validation: npm test passed. No blockers."

relaymux notify \
  --from build-agent \
  --reply-mode telegram \
  --idempotency-key "build-agent:job-123:done-telegram" \
  --message "Finished the build fix. Validation: npm test passed. No blockers."
```

Direct HTTP shape, if you cannot use the CLI helper:

```bash
TOKEN="$(cat ~/.relaymux/state/webhook-token)"
curl -sS -X POST http://127.0.0.1:47761/message \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"from":"build-agent","replyMode":"none","idempotencyKey":"build-agent:job-123:done","text":"Finished; tests passed."}'
```
