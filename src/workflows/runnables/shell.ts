import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";

import { ensureDirectory } from "../../paths.js";

const DEFAULT_SNIPPET_CHARS = 4000;
const SENSITIVE_ENV_KEY = /(TOKEN|SECRET|KEY|PASSWORD|AUTH|COOKIE|CREDENTIAL)/i;

export function shell(options: any = {}) {
  const normalized = normalizeShellOptions(options);
  return {
    kind: "shell",
    allowFailure: normalized.allowFailure,
    describe() {
      return {
        kind: "shell",
        argv: normalized.argv,
        cwd: normalized.cwd || "",
        env: safeEnvDescription(normalized.env),
        timeoutMs: normalized.timeoutMs || 0,
        allowFailure: normalized.allowFailure,
      };
    },
    execute(context) {
      return executeShell(normalized, context);
    },
  };
}

async function executeShell(options, context) {
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

  const child = spawn(options.argv[0], options.argv.slice(1), {
    cwd,
    env: { ...process.env, ...stringifyEnv(options.env) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk) => {
    stdoutStream.write(chunk);
    stdoutSnippet = appendSnippet(stdoutSnippet, chunk, options.maxSnippetChars);
  });
  child.stderr?.on("data", (chunk) => {
    stderrStream.write(chunk);
    stderrSnippet = appendSnippet(stderrSnippet, chunk, options.maxSnippetChars);
  });

  if (options.timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimeout = setTimeout(() => child.kill("SIGKILL"), 1000);
      forceKillTimeout.unref?.();
    }, options.timeoutMs);
    timeout.unref?.();
  }

  const completion: any = await new Promise((resolve) => {
    let settled = false;
    const finish = async (outcome) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      stdoutStream.end();
      stderrStream.end();
      await Promise.allSettled([finished(stdoutStream), finished(stderrStream)]);
      resolve(outcome);
    };

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
      argv: options.argv,
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

function normalizeShellOptions(options) {
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
