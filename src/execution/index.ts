import { launchLocalTmux } from "./local-tmux.js";

export function launchExecution(request) {
  return launchLocalTmux(request);
}
