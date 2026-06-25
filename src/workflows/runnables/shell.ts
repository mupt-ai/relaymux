import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";

import { ensureDirectory } from "../../paths.js";
import type { Runnable, RunnableExecutionContext, RunnableResult } from "../context.js";

const DEFAULT_SNIPPET_CHARS = 4000;
const HARD_KILL_GRACE_MS = 1000;
const STREAM_CLOSE_GRACE_MS = 250;
const SENSITIVE_ENV_KEY = /(TOKEN|SECRET|KEY|PASSWORD|AUTH|COOKIE|CREDENTIAL)/i;

export type ShellOptions = {
  argv: string[];
  cwd?: string;
  env?: Record<string, string | number | boolean>;
  timeoutMs?: number;
  allowFailure?: boolean;
  maxSnippetChars?: number;
};

export type ShellResultData = {
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

export type ShellResult = RunnableResult<ShellResultData>;

export function shell(options: ShellOptions): Runnable<ShellResultData> {
  const normalized = normalizeShellOptions(options);
  return {
    kind: "shell",
    allowFailure: normalized.allowFailure,
    describe() {
      return {
        kind: "shell",
        argv: safeArgvDescription(normalized.argv),
        cwd: normalized.cwd || "",
        env: safeEnvDescription(normalized.env),
        timeoutMs: normalized.timeoutMs || 0,
        allowFailure: normalized.allowFailure,
      };
    },
    digest() {
      return {
        kind: "shell",
        argv: normalized.argv,
        cwd: normalized.cwd || "",
        env: normalized.env,
        timeoutMs: normalized.timeoutMs || 0,
        allowFailure: normalized.allowFailure,
      };
    },
    execute(context) {
      return executeShell(normalized, context);
    },
  };
}

async function executeShell(options, context: RunnableExecutionContext): Promise<ShellResult> {
  const startedAt = new Date().toISOString();
  const cwd = resolveCwd(options.cwd, context.cwd || process.cwd());
  const stdoutPath = path.join(context.attemptDir, "stdout.log");
  const stderrPath = path.join(context.attemptDir, "stderr.log");
  ensureDirectory(path.dirname(stdoutPath));

  const stdoutStream = fs.createWriteStream(stdoutPath, { flags: "a", mode: 0o600 });
  const stderrStream = fs.createWriteStream(stderrPath, { flags: "a", mode: 0o600 });
  let stdoutSnippet = "";
  let stderrSnippet = "";
  let timedOut = false;
  let timeout: NodeJS.Timeout | null = null;
  let forceKillTimeout: NodeJS.Timeout | null = null;
  const useProcessGroup = process.platform !== "win32";

  const child = spawn(options.argv[0], options.argv.slice(1), {
    cwd,
    env: { ...process.env, ...stringifyEnv(options.env) },
    detached: useProcessGroup,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const onStdoutData = (chunk) => {
    if (!stdoutStream.destroyed && !stdoutStream.writableEnded) {
      stdoutStream.write(chunk);
    }
    stdoutSnippet = appendSnippet(stdoutSnippet, chunk, options.maxSnippetChars);
  };
  const onStderrData = (chunk) => {
    if (!stderrStream.destroyed && !stderrStream.writableEnded) {
      stderrStream.write(chunk);
    }
    stderrSnippet = appendSnippet(stderrSnippet, chunk, options.maxSnippetChars);
  };
  child.stdout?.on("data", onStdoutData);
  child.stderr?.on("data", onStderrData);

  const completion: any = await new Promise((resolve) => {
    let settled = false;
    const finish = async (outcome) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      child.stdout?.off("data", onStdoutData);
      child.stderr?.off("data", onStderrData);
      await closeOutputStreams(stdoutStream, stderrStream);
      resolve(outcome);
    };

    if (options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child, "SIGTERM", useProcessGroup);
        forceKillTimeout = setTimeout(() => {
          terminateProcessTree(child, "SIGKILL", useProcessGroup);
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish({ error: null, exitCode: null, signal: "SIGKILL" });
        }, HARD_KILL_GRACE_MS);
        forceKillTimeout.unref?.();
      }, options.timeoutMs);
      timeout.unref?.();
    }

    child.once("error", (error) => {
      stderrStream.write(`${error.message}\n`);
      stderrSnippet = appendSnippet(stderrSnippet, `${error.message}\n`, options.maxSnippetChars);
      finish({ error, exitCode: null, signal: null });
    });
    child.once("close", (exitCode, signal) => {
      finish({ error: null, exitCode, signal });
    });
  });

  const endedAt = new Date().toISOString();
  const status = timedOut
    ? "timed_out"
    : completion.exitCode === 0
      ? "succeeded"
      : "failed";

  return {
    ok: status === "succeeded",
    status,
    startedAt,
    endedAt,
    data: {
      argv: safeArgvDescription(options.argv),
      cwd,
      exitCode: completion.exitCode,
      signal: completion.signal,
      timedOut,
      stdoutSnippet,
      stderrSnippet,
      stdoutPath,
      stderrPath,
      error: completion.error ? { message: completion.error.message } : null,
    },
    artifacts: {
      stdout: stdoutPath,
      stderr: stderrPath,
    },
  };
}

function normalizeShellOptions(options: ShellOptions = { argv: [] }) {
  if (!Array.isArray(options.argv) || options.argv.length === 0) {
    throw new Error("shell({ argv }) requires a non-empty argv array");
  }
  const argv = options.argv.map((part) => String(part));
  const timeoutMs = Number(options.timeoutMs || 0);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("shell({ timeoutMs }) must be a non-negative number");
  }
  return {
    argv,
    cwd: options.cwd ? String(options.cwd) : "",
    env: normalizeEnv(options.env || {}),
    timeoutMs: Math.floor(timeoutMs),
    allowFailure: Boolean(options.allowFailure),
    maxSnippetChars: normalizePositiveInteger(options.maxSnippetChars, DEFAULT_SNIPPET_CHARS),
  };
}

function normalizeEnv(env) {
  const normalized = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name "${key}"`);
    }
    normalized[key] = String(value);
  }
  return normalized;
}

function stringifyEnv(env) {
  const result = {};
  for (const [key, value] of Object.entries(env || {})) {
    result[key] = String(value);
  }
  return result;
}

function safeEnvDescription(env) {
  const result = {};
  for (const key of Object.keys(env || {}).sort()) {
    result[key] = SENSITIVE_ENV_KEY.test(key) ? "<redacted>" : "<set>";
  }
  return result;
}

function safeArgvDescription(argv) {
  const safe: string[] = [];
  let redactNext = false;
  for (const raw of argv || []) {
    const value = String(raw);
    if (redactNext) {
      safe.push("<redacted>");
      redactNext = false;
      continue;
    }

    const assignment = value.match(/^([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|AUTH|COOKIE|CREDENTIAL)[A-Za-z0-9_]*)=(.*)$/i);
    if (assignment) {
      safe.push(`${assignment[1]}=<redacted>`);
      continue;
    }

    const flagWithValue = value.match(/^(--?[A-Za-z0-9_.-]*(?:token|secret|key|password|auth|cookie|credential)[A-Za-z0-9_.-]*)=(.*)$/i);
    if (flagWithValue) {
      safe.push(`${flagWithValue[1]}=<redacted>`);
      continue;
    }

    if (/^--?[A-Za-z0-9_.-]*(?:token|secret|key|password|auth|cookie|credential)[A-Za-z0-9_.-]*$/i.test(value)) {
      safe.push(value);
      redactNext = true;
      continue;
    }

    if (SENSITIVE_ENV_KEY.test(value)) {
      safe.push("<redacted>");
      continue;
    }

    safe.push(redactUrlCredentials(value));
  }
  return safe;
}

function redactUrlCredentials(value) {
  return value.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/@\s:]+):([^/@\s]+)@/g, "$1<redacted>@");
}

function resolveCwd(cwd, baseCwd) {
  if (!cwd) return baseCwd;
  return path.isAbsolute(cwd) ? cwd : path.resolve(baseCwd, cwd);
}

function appendSnippet(current, chunk, maxChars) {
  const next = current + String(chunk);
  return next.length > maxChars ? next.slice(next.length - maxChars) : next;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function terminateProcessTree(child, signal, useProcessGroup) {
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill(signal);
    } catch {}
    return;
  }

  if (process.platform === "win32") {
    if (signal === "SIGKILL") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {});
    }
    try {
      child.kill(signal);
    } catch {}
    return;
  }

  if (useProcessGroup) {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if (error?.code === "ESRCH") return;
    }
  }

  try {
    child.kill(signal);
  } catch {}
}

async function closeOutputStreams(stdoutStream, stderrStream) {
  for (const stream of [stdoutStream, stderrStream]) {
    if (!stream.destroyed && !stream.writableEnded) {
      stream.end();
    }
  }

  await Promise.race([
    Promise.allSettled([finished(stdoutStream), finished(stderrStream)]),
    delay(STREAM_CLOSE_GRACE_MS),
  ]);

  for (const stream of [stdoutStream, stderrStream]) {
    if (!stream.destroyed && !stream.closed) {
      stream.destroy();
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
