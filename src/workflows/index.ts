import type { WorkflowContext } from "./context.js";

export { shell } from "./runnables/shell.js";
export type { WorkflowContext } from "./context.js";

export type WorkflowRunFunction<TInput = unknown, TOutput = unknown> = (
  context: WorkflowContext,
  input: TInput,
) => Promise<TOutput> | TOutput;

export type WorkflowDefinition<TInput = unknown, TOutput = unknown> = {
  name?: string;
  run: WorkflowRunFunction<TInput, TOutput>;
};

export function defineWorkflow<TInput = unknown, TOutput = unknown>(
  definition: WorkflowDefinition<TInput, TOutput>,
) {
  if (!definition || typeof definition.run !== "function") {
    throw new Error("defineWorkflow requires an object with a run(ctx, input) function");
  }
  return {
    ...definition,
    __relaymuxWorkflow: true,
  };
}
