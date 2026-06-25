# relaymux

`relaymux` is a lightweight metaharness for coding agents.

Telegram or iMessage can be the remote control / orchestrator. Agent work runs locally in `tmux`; every delegated subagent is a visible tmux tab/window.

## Requirements

You need Node.js 20+, npm, and a local agent CLI such as `pi`, `codex`, or `claude`.

`tmux` is required for agent launches.

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

relaymux passes the message to your configured local orchestrator. If the orchestrator launches an agent, that agent runs in `tmux`; the final reply comes back through Telegram.

Manual notification test:

```bash
relaymux notify --from test --reply-mode telegram --message "hello from relaymux"
```

## Agent Execution

`relaymux launch` opens a tmux tab/window for the selected local agent:

```bash
relaymux launch \
  --repo ~/code/my-app \
  --agent pi \
  --name inspect-tests \
  --prompt "Inspect the failing tests and summarize what is broken."
```

`--group <name>` groups runs and becomes the tmux session when `--session` is not provided. Existing `--session` and `--session-mode shared|per-worktree` behavior remains supported.

Agent names are resolved exactly from `config.agents`; use names like `claude` or `codex` directly.

relaymux uses one shared `tmux` session named `agents` by default. Each launched agent gets its own tmux window. Telegram starts and receives updates from work, but tmux keeps that work visible and recoverable locally.

Attach any time:

```bash
tmux attach -t agents
```

Detach with `Ctrl-b d`. Closing Telegram does not stop the tmux run.

## TypeScript workflows

`relaymux workflow` is the first focused workflow runner. It runs in the foreground, loads a local `.ts` or `.js` workflow file, and persists workflow state under:

```text
<stateDir>/workflows/<workflowRunId>/
```

Run a workflow file:

```bash
relaymux workflow run ./workflow.ts \
  --name quality-gate \
  --input-json '{"repo":"."}'
```

Inspect it later:

```bash
relaymux workflow list
relaymux workflow status <workflowRunId> --events
```

JSON output is available for automation:

```bash
relaymux workflow run ./workflow.ts --name quality-gate --json
relaymux workflow status <workflowRunId> --events --json
relaymux workflow list --json
```

Workflow files run through `relaymux workflow run` can import the SDK facade from `@relaymux/workflows`:

```ts
import { defineWorkflow, shell, type WorkflowContext, type ShellResult } from "@relaymux/workflows";

type Input = { repo: string };

export default defineWorkflow<Input, { ok: boolean }>({
  async run(ctx: WorkflowContext<Input>, input) {
    const tests: ShellResult = await ctx.step("tests", shell({
      argv: ["npm", "run", "validate"],
      cwd: input.repo,
      timeoutMs: 20 * 60 * 1000,
    }));
    return { ok: tests.ok };
  },
});
```

The public SDK exports `defineWorkflow`, `WorkflowContext<TInput>`, `Runnable<T>`, `RunnableResult<T>`, `shell`, `ShellResult`, and `ShellResultData`. `ctx.step<T>()` returns the typed runnable result, so a shell step returns `ShellResult`.

For editor or `tsc` support in an external workflow repo, install `relaymux` and either import the package subpath:

```ts
import { defineWorkflow, shell } from "relaymux/workflows";
```

or keep the runtime facade import and add a local path alias:

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "paths": {
      "@relaymux/workflows": ["./node_modules/relaymux/dist/src/workflows/index.d.ts"]
    }
  }
}
```

`WorkflowContext` provides:

- `ctx.step(stepId, runnable)`: runs one typed runnable and persists step state. Duplicate `stepId` values within one run throw instead of replaying cached output.
- `ctx.emit(event, data)`: appends a workflow event.
- `ctx.artifact(name, content)`: writes a run artifact and emits an artifact event.
- `ctx.workflowRunId`, `ctx.runDir`, `ctx.name`, and `ctx.input`.

The MVP deliberately supports only foreground workflow runs and the `shell({ argv, cwd?, env?, timeoutMs?, allowFailure?, maxSnippetChars? })` runnable. `shell` inherits the parent environment plus `env` overrides, records full stdout/stderr logs as artifacts, and returns:

```ts
type ShellResult = {
  ok: boolean;
  status: "succeeded" | "failed" | "timed_out" | string;
  data: {
    argv: string[];
    cwd: string;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    stdoutSnippet: string;
    stderrSnippet: string;
    stdoutPath: string;
    stderrPath: string;
    error: { message: string } | null;
  };
  artifacts: { stdout: string; stderr: string };
};
```

`maxSnippetChars` defaults to 4000 and bounds only `stdoutSnippet`/`stderrSnippet`; the artifact log files contain the full stream output for the step. Secret-looking argv and explicit env values are redacted in descriptors, but workflow authors should still avoid printing secrets to stdout/stderr.

`timeoutMs` has no default. When set, relaymux terminates the shell process tree on timeout on POSIX and uses a best-effort fallback elsewhere. A timed-out required step marks the workflow run `timed_out`. There is no built-in cancellation API, no daemon/background workflow supervisor, and shell steps are not intended for long-lived background services.

Idempotency keys are scoped to `name + idempotencyKey + definitionHash + inputHash`. A matching running or succeeded run is reused. Reusing the same key with changed input or changed workflow file contents fails with an idempotency conflict. Failed, timed-out, or canceled prior runs do not wedge the key; the same definition/input/key starts a new attempt. Concurrent starts for the same tuple reserve one run before execution so duplicate launches do not both run steps.

`workflow list` is the script-friendly list command. Bare `workflow status` without a run id is kept as an interactive alias for the same table; use `workflow status <workflowRunId> --events` for a single run. `workflow status --events` requires a run id.

Unsupported workflow-platform features such as background workflow supervision, agent loops, approvals, retries, HTTP steps, and cancellation are not implemented yet.

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

That command opens a tmux tab/window in the configured relaymux session.
