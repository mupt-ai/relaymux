import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expandPath } from "../paths.js";

export async function loadWorkflowDefinition({ definitionFile, runDir }: any) {
  const absoluteFile = expandPath(definitionFile);
  if (!fs.existsSync(absoluteFile) || !fs.statSync(absoluteFile).isFile()) {
    throw new Error(`Workflow file does not exist: ${absoluteFile}`);
  }

  const compiledFile = path.join(runDir, "workflow.mjs");
  await build({
    entryPoints: [absoluteFile],
    outfile: compiledFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: "inline",
    logLevel: "silent",
    plugins: [workflowSdkAliasPlugin()],
  });

  const moduleUrl = `${pathToFileURL(compiledFile).href}?v=${Date.now()}`;
  const loaded = await import(moduleUrl);
  const definition = loaded.default || loaded.workflow;
  if (!definition || typeof definition.run !== "function") {
    throw new Error("Workflow module must export default defineWorkflow({ run(ctx, input) { ... } })");
  }
  return definition;
}

function workflowSdkAliasPlugin() {
  return {
    name: "relaymux-workflows-alias",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^(?:@relaymux\/workflows|relaymux\/workflows)$/ }, () => ({
        path: workflowSdkEntryPath(),
      }));
    },
  };
}

function workflowSdkEntryPath() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(dir, "index.ts"),
    path.join(dir, "index.js"),
  ];
  const match = candidates.find((candidate) => fs.existsSync(candidate));
  if (!match) {
    throw new Error("Could not locate relaymux workflow SDK entrypoint");
  }
  return match;
}
