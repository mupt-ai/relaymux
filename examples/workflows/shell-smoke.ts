import { defineWorkflow, shell } from "@relaymux/workflows";

export default defineWorkflow<{ message?: string }>({
  name: "shell-smoke",
  async run(ctx, input) {
    const message = input.message || "hello from relaymux workflow";
    ctx.emit("workflow_message", { message });

    const result = await ctx.step("print-message", shell({
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write(process.argv[1])",
        message,
      ],
      timeoutMs: 5000,
    }));

    const summaryPath = ctx.artifact("summary.json", {
      ok: result.ok,
      stdout: result.data.stdoutSnippet,
    });

    return {
      ok: result.ok,
      stdout: result.data.stdoutSnippet,
      summaryPath,
    };
  },
});
