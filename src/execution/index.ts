import { launchCloudSandbox } from "./cloud-sandbox.js";
import { launchLocalBackground } from "./local-background.js";
import { launchLocalTmux } from "./local-tmux.js";

export function launchExecution(request) {
  if (request.executor === "local-tmux") return launchLocalTmux(request);
  if (request.executor === "local-background") return launchLocalBackground(request);
  if (request.executor === "cloud-sandbox") return launchCloudSandbox(request);
  throw new Error(`Unknown executor "${request.executor}"`);
}

