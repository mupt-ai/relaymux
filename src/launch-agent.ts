import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveLogDir } from "./config.js";
import { quoteArgv } from "./command.js";
import { expandPath, ensureDirectory } from "./paths.js";
import { runCommand } from "./process.js";
import { killWindowByName, validateSessionName } from "./tmux.js";

export function launchAgentPath(config) {
  const label = launchAgentLabel(config);
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

export function launchAgentWatchdogPath(config) {
  const label = launchAgentWatchdogLabel(config);
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

export function launchAgentLabel(config) {
  return config.daemon?.launchAgentLabel || "com.relaymux.daemon";
}

export function launchAgentWatchdogLabel(config) {
  return `${launchAgentLabel(config)}.watchdog`;
}

export function backgroundServicePath(config, { platform = process.platform, env = process.env }: any = {}) {
  return platform === "linux" ? systemdUserUnitPath(config, env) : launchAgentPath(config);
}

export function systemdServiceName(config) {
  const configured = config.daemon?.systemdServiceName || config.daemon?.systemdUnitName || launchAgentLabel(config);
  const raw = String(configured || "relaymux-daemon").trim();
  const withoutSuffix = raw.endsWith(".service") ? raw.slice(0, -".service".length) : raw;
  const safe = withoutSuffix
    .replace(/[^A-Za-z0-9:_.@-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "relaymux-daemon";
  return `${safe}.service`;
}

export function systemdUserUnitPath(config, env = process.env) {
  const configHome = env.XDG_CONFIG_HOME ? expandPath(env.XDG_CONFIG_HOME) : path.join(os.homedir(), ".config");
  return path.join(configHome, "systemd", "user", systemdServiceName(config));
}

export function renderLaunchAgentPlist({
  label,
  programArguments,
  workingDirectory,
  standardOutPath,
  standardErrorPath,
  environment = {},
  keepAlive = true,
  runAtLoad = true,
  startInterval = 0,
  startCalendarIntervals = [],
}) {
  const args = programArguments.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n");
  const env = renderEnvironment(environment);
  const interval = renderStartInterval(startInterval);
  const calendarIntervals = renderStartCalendarIntervals(startCalendarIntervals);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(workingDirectory)}</string>${env}
  <key>RunAtLoad</key>
  ${runAtLoad ? "<true/>" : "<false/>"}
  <key>KeepAlive</key>
  ${keepAlive ? "<true/>" : "<false/>"}${interval}${calendarIntervals}
  <key>StandardOutPath</key>
  <string>${xmlEscape(standardOutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(standardErrorPath)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUserServiceUnit({
  serviceName,
  programArguments,
  workingDirectory,
  standardOutPath,
  standardErrorPath,
  environment = {},
  restartSec = 5,
}) {
  const env = renderSystemdEnvironment(environment);
  return `[Unit]
Description=relaymux background daemon
Documentation=https://github.com/mupt-ai/relaymux
After=network.target

[Service]
Type=simple
WorkingDirectory=${systemdUnitValue(workingDirectory)}
ExecStart=${programArguments.map(systemdUnitValue).join(" ")}
Restart=always
RestartSec=${Math.max(1, Math.floor(Number(restartSec) || 5))}
${env}StandardOutput=${systemdUnitValue(`append:${standardOutPath}`)}
StandardError=${systemdUnitValue(`append:${standardErrorPath}`)}

[Install]
WantedBy=default.target
`;
}

export function installLaunchAgent({ flags, configInfo, binPath, io, platform = process.platform }) {
  if (!configInfo.exists) {
    throw new Error(`Config does not exist at ${configInfo.path}. Run relaymux setup first.`);
  }

  if (platform === "linux") {
    return installSystemdUserService({ flags, configInfo, binPath, io, env: io.env || process.env });
  }
  if (platform !== "darwin") {
    throw new Error(`Background service installation is not supported on ${platform}. Run \`relaymux daemon\` manually or use an external service manager.`);
  }

  const config = configInfo.config;
  const label = launchAgentLabel(config);
  const plistPath = launchAgentPath(config);
  const logDir = resolveLogDir(config);
  const workingDirectory = expandPath(config.orchestrator?.cwd || "~");
  const launchMode = resolveLaunchMode(flags, config);
  const session = String(flags.session || config.session || "agents");
  if ((config.daemon?.launchMode === "tmux" || config.daemon?.launchMode === "supervised-tmux") && !flags.mode && !flags.launchMode) {
    io.stderr.write("relaymux: daemon.launchMode=tmux is deprecated; installing direct/background LaunchAgent instead.\n");
  }
  const programArguments = buildDirectDaemonArgs({ binPath, configPath: configInfo.path });
  const logPrefix = "daemon";
  const plist = renderLaunchAgentPlist({
    label,
    programArguments,
    workingDirectory,
    environment: launchAgentEnvironment(config, configInfo.path),
    standardOutPath: path.join(logDir, `${logPrefix}.out.log`),
    standardErrorPath: path.join(logDir, `${logPrefix}.err.log`),
  });

  if (flags.dryRun) {
    io.stdout.write(plist);
    return plistPath;
  }

  ensureDirectory(path.dirname(plistPath));
  ensureDirectory(logDir);
  fs.writeFileSync(plistPath, plist, { mode: 0o644 });
  io.stdout.write(`Wrote ${plistPath}\n`);
  io.stdout.write(`LaunchAgent ${label} mode: ${launchMode}/background (no tmux)\n`);

  if (shouldInstallWatchdog(config, flags)) {
    installLaunchAgentWatchdog({
      config,
      configPath: configInfo.path,
      binPath,
      io,
      load: flags.load !== false,
      platform,
    });
  }

  if (flags.load !== false) {
    const target = launchAgentTarget(config);
    if (process.platform === "darwin" && isCurrentLaunchAgent(config, process.env) && flags.immediateSelfRestart !== true) {
      scheduleLaunchAgentReloadHelper({ config, plistPath, io });
      return plistPath;
    }

    runCommand("launchctl", ["bootout", target], { allowFailure: true });
    runCommand("/bin/sleep", ["1"], { allowFailure: true });
    if (process.platform === "darwin" && launchMode === "direct" && flags.keepTmuxDaemon !== true) {
      const windowName = String(flags.windowName || "relaymux-daemon");
      try {
        validateSessionName(session);
        if (killWindowByName({ session, name: windowName })) {
          io.stdout.write(`Stopped tmux daemon window ${session}:${windowName}\n`);
        }
      } catch (error) {
        io.stderr.write(`relaymux: skipped old tmux daemon cleanup: ${error.message}\n`);
      }
    }
    const result = loadLaunchAgentTarget({ target, domain: launchAgentDomain(), plistPath });
    if (result.status !== 0) {
      io.stderr.write(formatLaunchAgentLoadFailure({
        label,
        result,
        domain: launchAgentDomain(),
        target,
        plistPath,
        logDir,
        stdoutLog: path.join(logDir, `${logPrefix}.out.log`),
        stderrLog: path.join(logDir, `${logPrefix}.err.log`),
      }));
    }
  }
  return plistPath;
}

function installSystemdUserService({ flags, configInfo, binPath, io, env = process.env }) {
  const config = configInfo.config;
  const serviceName = systemdServiceName(config);
  const unitPath = systemdUserUnitPath(config, env);
  const logDir = resolveLogDir(config, env);
  const workingDirectory = expandPath(config.orchestrator?.cwd || "~");
  const launchMode = resolveLaunchMode(flags, config);
  if ((config.daemon?.launchMode === "tmux" || config.daemon?.launchMode === "supervised-tmux") && !flags.mode && !flags.launchMode) {
    io.stderr.write("relaymux: daemon.launchMode=tmux is deprecated; installing direct/background systemd user service instead.\n");
  }
  const programArguments = buildDirectDaemonArgs({ binPath, configPath: configInfo.path });
  const logPrefix = "daemon";
  const stdoutLog = path.join(logDir, `${logPrefix}.out.log`);
  const stderrLog = path.join(logDir, `${logPrefix}.err.log`);
  const unit = renderSystemdUserServiceUnit({
    serviceName,
    programArguments,
    workingDirectory,
    environment: launchAgentEnvironment(config, configInfo.path),
    standardOutPath: stdoutLog,
    standardErrorPath: stderrLog,
    restartSec: config.daemon?.systemdRestartSec || config.daemon?.restartSec || 5,
  });

  if (flags.dryRun) {
    io.stdout.write(unit);
    return unitPath;
  }

  ensureDirectory(path.dirname(unitPath));
  ensureDirectory(logDir);
  fs.writeFileSync(unitPath, unit, { mode: 0o644 });
  io.stdout.write(`Wrote ${unitPath}\n`);
  io.stdout.write(`Background service ${serviceName} mode: ${launchMode}/background systemd user service (no tmux)\n`);

  if (flags.watchdog !== false) {
    io.stdout.write("Linux uses systemd Restart=always for daemon recovery; no separate watchdog unit is installed.\n");
  }

  if (flags.load !== false) {
    const result = loadSystemdUserService({ serviceName });
    if (result.status !== 0) {
      io.stderr.write(formatSystemdServiceLoadFailure({
        serviceName,
        result,
        unitPath,
        logDir,
        stdoutLog,
        stderrLog,
      }));
    } else {
      io.stdout.write(`Enabled and started systemd user service ${serviceName}\n`);
    }
  }

  return unitPath;
}

export function installLaunchAgentWatchdog({ config, configPath, binPath, io, load = true, platform = process.platform }) {
  if (platform !== "darwin") {
    return null;
  }

  const scriptPath = launchAgentWatchdogScriptPath(config);
  const plistPath = launchAgentWatchdogPath(config);
  const logDir = resolveLogDir(config);
  const scriptSourcePath = resolveWatchdogSourcePath(binPath);
  const script = fs.readFileSync(scriptSourcePath, "utf8");
  ensureDirectory(path.dirname(scriptPath));
  ensureDirectory(path.dirname(plistPath));
  ensureDirectory(logDir);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  try { fs.chmodSync(scriptPath, 0o755); } catch {}

  const plist = renderLaunchAgentWatchdogPlist({ config, configPath, scriptPath });
  fs.writeFileSync(plistPath, plist, { mode: 0o644 });
  io.stdout.write(`Wrote ${plistPath}\n`);

  if (load) {
    const target = launchAgentWatchdogTarget(config);
    const result = loadLaunchAgentTarget({ target, domain: launchAgentDomain(), plistPath });
    if (result.status !== 0) {
      io.stderr.write(formatLaunchAgentLoadFailure({
        label: launchAgentWatchdogLabel(config),
        result,
        domain: launchAgentDomain(),
        target,
        plistPath,
        logDir,
        stdoutLog: path.join(logDir, "launch-agent-watchdog.out.log"),
        stderrLog: path.join(logDir, "launch-agent-watchdog.err.log"),
      }));
    }
  }

  return { plistPath, scriptPath };
}

export function renderLaunchAgentWatchdogPlist({ config, configPath, scriptPath }) {
  const logDir = resolveLogDir(config);
  const label = launchAgentWatchdogLabel(config);
  return renderLaunchAgentPlist({
    label,
    programArguments: ["/bin/sh", scriptPath],
    workingDirectory: os.homedir(),
    environment: {
      PATH: defaultLaunchPath(),
      HOME: os.homedir(),
      RELAYMUX_CONFIG: configPath,
      RELAYMUX_MAIN_LABEL: launchAgentLabel(config),
      RELAYMUX_MAIN_PLIST: launchAgentPath(config),
      RELAYMUX_HEALTH_URL: launchAgentHealthUrl(config),
      RELAYMUX_WATCHDOG_LOG: path.join(logDir, "launch-agent-watchdog.log"),
    },
    standardOutPath: path.join(logDir, "launch-agent-watchdog.out.log"),
    standardErrorPath: path.join(logDir, "launch-agent-watchdog.err.log"),
    keepAlive: false,
    startInterval: launchAgentWatchdogIntervalSeconds(config),
  });
}

export function stopLaunchAgent({ config, io, platform = process.platform }) {
  if (platform === "linux") {
    const serviceName = systemdServiceName(config);
    const result = runCommand("systemctl", ["--user", "stop", serviceName], { allowFailure: true });
    if (result.status === 0) {
      io.stdout.write(`Stopped systemd user service ${serviceName}\n`);
      return true;
    }
    return false;
  }

  if (platform !== "darwin") {
    return false;
  }

  const label = launchAgentLabel(config);
  const result = runCommand("launchctl", ["bootout", launchAgentTarget(config)], { allowFailure: true });
  if (result.status === 0) {
    io.stdout.write(`Stopped LaunchAgent ${label}\n`);
    return true;
  }
  return false;
}

export function restartLaunchAgent({ flags, configInfo, binPath, io, platform = process.platform }) {
  const plistPath = installLaunchAgent({
    flags: { ...flags, load: true },
    configInfo,
    binPath,
    io,
    platform,
  });
  printLaunchAgentStatus({ config: configInfo.config, io, platform });
  return plistPath;
}

export function printLaunchAgentStatus({ config, io, json = false, platform = process.platform }) {
  const status: any = getLaunchAgentStatus(config, { platform, env: io.env || process.env });
  const watchdog: any = getLaunchAgentWatchdogStatus(config, { platform, env: io.env || process.env });
  if (json) {
    const payload = { ...status, watchdog };
    io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }

  if (status.serviceManager === "systemd") {
    return printSystemdServiceStatus({ status, config, io });
  }

  if (!status.supported) {
    io.stdout.write(`Background service ${status.label}: direct/background (no tmux) unsupported on ${platform}; path ${status.plistPath}\n`);
    return status;
  }

  if (!status.loaded) {
    io.stdout.write(`LaunchAgent ${status.label}: direct/background (no tmux) not loaded; plist ${status.plistExists ? status.plistPath : "missing"}\n`);
    if (status.detail) io.stdout.write(`Detail: ${status.detail}\n`);
    io.stdout.write(`Logs: ${path.join(resolveLogDir(config), "daemon.out.log")} and ${path.join(resolveLogDir(config), "daemon.err.log")}\n`);
    io.stdout.write(`Inspect: launchctl print ${status.target}\n`);
    io.stdout.write("Next: relaymux restart-launch-agent\n");
    return status;
  }

  const pidText = status.pid ? ` pid=${status.pid}` : "";
  const exitText = status.lastExitCode ? ` lastExit=${status.lastExitCode}` : "";
  io.stdout.write(`LaunchAgent ${status.label}: direct/background (no tmux) loaded state=${status.state || "unknown"}${pidText}${exitText}; plist ${status.plistPath}\n`);
  if (watchdog.enabled) {
    const watchdogText = watchdog.loaded
      ? `loaded state=${watchdog.state || "unknown"}${watchdog.pid ? ` pid=${watchdog.pid}` : ""}`
      : `not loaded${watchdog.detail ? ` (${watchdog.detail})` : ""}`;
    io.stdout.write(`Watchdog ${watchdog.label}: interval=${watchdog.intervalSeconds}s ${watchdogText}; plist ${watchdog.plistPath}; script ${watchdog.scriptPath}\n`);
  }
  return status;
}

function printSystemdServiceStatus({ status, config, io }) {
  const logDir = resolveLogDir(config, io.env || process.env);
  if (!status.supported) {
    io.stdout.write(`Background service ${status.serviceName}: systemd user services unavailable; unit ${status.unitPath}\n`);
    if (status.detail) io.stdout.write(`Detail: ${status.detail}\n`);
    io.stdout.write(`Logs: ${path.join(logDir, "daemon.out.log")} and ${path.join(logDir, "daemon.err.log")}\n`);
    io.stdout.write(`Inspect: systemctl --user status ${status.serviceName}\n`);
    io.stdout.write(`Journal: journalctl --user -u ${status.serviceName} -e\n`);
    io.stdout.write("Fallback: run `relaymux daemon` in a foreground shell, or enable systemd user services and run `relaymux restart-launch-agent`.\n");
    return status;
  }

  if (!status.loaded) {
    io.stdout.write(`Background service ${status.serviceName}: systemd user service not active; unit ${status.unitExists ? status.unitPath : "missing"}\n`);
    if (status.detail) io.stdout.write(`Detail: ${status.detail}\n`);
    io.stdout.write(`Logs: ${path.join(logDir, "daemon.out.log")} and ${path.join(logDir, "daemon.err.log")}\n`);
    io.stdout.write(`Inspect: systemctl --user status ${status.serviceName}\n`);
    io.stdout.write(`Journal: journalctl --user -u ${status.serviceName} -e\n`);
    io.stdout.write("Next: relaymux restart-launch-agent (writes and restarts the Linux systemd user service)\n");
    return status;
  }

  const pidText = status.pid ? ` pid=${status.pid}` : "";
  const exitText = status.lastExitCode ? ` lastExit=${status.lastExitCode}` : "";
  const stateText = [status.activeState, status.subState].filter(Boolean).join("/") || status.state || "unknown";
  io.stdout.write(`Background service ${status.serviceName}: systemd user service active state=${stateText}${pidText}${exitText}; unit ${status.unitPath}\n`);
  io.stdout.write("Restart policy: systemd Restart=always (no separate watchdog unit on Linux)\n");
  return status;
}

export function getLaunchAgentStatus(config, { platform = process.platform, env = process.env }: any = {}) {
  if (platform === "linux") {
    return getSystemdUserServiceStatus(config, env);
  }
  if (platform !== "darwin") {
    return unsupportedBackgroundServiceStatus(config, platform, env);
  }
  return getLaunchAgentStatusFor({
    label: launchAgentLabel(config),
    plistPath: launchAgentPath(config),
    target: launchAgentTarget(config),
    platform,
  });
}

export function getLaunchAgentWatchdogStatus(config, { platform = process.platform }: any = {}) {
  if (platform === "linux") {
    return {
      label: "systemd Restart=always",
      enabled: false,
      supported: true,
      loaded: false,
      running: false,
      state: "managed-by-systemd",
      serviceManager: "systemd",
      detail: "Linux systemd user service units use Restart=always; no separate watchdog unit is installed.",
      intervalSeconds: 0,
      plistPath: "",
      scriptPath: "",
    };
  }
  if (platform !== "darwin") {
    return {
      label: launchAgentWatchdogLabel(config),
      enabled: false,
      supported: false,
      loaded: false,
      running: false,
      state: "unsupported",
      serviceManager: "unsupported",
      intervalSeconds: 0,
      plistPath: launchAgentWatchdogPath(config),
      scriptPath: launchAgentWatchdogScriptPath(config),
    };
  }
  return {
    ...getLaunchAgentStatusFor({
      label: launchAgentWatchdogLabel(config),
      plistPath: launchAgentWatchdogPath(config),
      target: launchAgentWatchdogTarget(config),
      platform,
    }),
    enabled: shouldInstallWatchdog(config, {}),
    intervalSeconds: launchAgentWatchdogIntervalSeconds(config),
    scriptPath: launchAgentWatchdogScriptPath(config),
  };
}

export function formatLaunchAgentLoadFailure({ label, result, domain, target, plistPath, logDir, stdoutLog, stderrLog }) {
  const detail = firstLine(result.stderr) || firstLine(result.stdout) || "no launchctl detail";
  return [
    `relaymux: launchctl bootstrap failed for ${label} (status ${result.status}: ${detail})`,
    `  plist: ${plistPath}`,
    `  logs: ${stdoutLog || path.join(logDir, "daemon.out.log")} and ${stderrLog || path.join(logDir, "daemon.err.log")}`,
    `  inspect: launchctl print ${target}`,
    "  common causes: invalid plist, missing executable path, bad WorkingDirectory, or file permission problems",
    `  next: run relaymux status-launch-agent; after fixing the issue, run relaymux restart-launch-agent`,
    `  manual load: launchctl bootstrap ${domain} ${plistPath}`,
    "",
  ].join("\n");
}

export function formatSystemdServiceLoadFailure({ serviceName, result, unitPath, logDir, stdoutLog, stderrLog }) {
  const detail = systemdFailureDetail(result);
  return [
    `relaymux: systemctl --user failed for ${serviceName} (status ${result.status}: ${detail})`,
    `  unit: ${unitPath}`,
    `  logs: ${stdoutLog || path.join(logDir, "daemon.out.log")} and ${stderrLog || path.join(logDir, "daemon.err.log")}`,
    `  inspect: systemctl --user status ${serviceName}`,
    `  journal: journalctl --user -u ${serviceName} -e`,
    "  common causes: systemd user services unavailable, missing executable path, bad WorkingDirectory, or file permission problems",
    "  next: run relaymux status-launch-agent; after fixing the issue, run relaymux restart-launch-agent",
    "  fallback: run relaymux daemon in a foreground shell when systemd --user is unavailable",
    "",
  ].join("\n");
}

function getSystemdUserServiceStatus(config, env = process.env) {
  const serviceName = systemdServiceName(config);
  const unitPath = systemdUserUnitPath(config, env);
  const unitExists = fs.existsSync(unitPath);
  const base = {
    label: launchAgentLabel(config),
    serviceName,
    unitPath,
    plistPath: unitPath,
    unitExists,
    plistExists: unitExists,
    target: serviceName,
    supported: true,
    serviceManager: "systemd",
    mode: "direct",
    background: true,
  };

  const result = runCommand("systemctl", ["--user", "show", serviceName, "--no-page"], { allowFailure: true });
  if (result.status !== 0) {
    const unavailable = isSystemdUserUnavailable(result);
    return {
      ...base,
      supported: !unavailable,
      loaded: false,
      running: false,
      state: unavailable ? "unavailable" : "not-active",
      detail: systemdFailureDetail(result),
    };
  }

  const parsed = parseSystemctlShow(result.stdout);
  const active = parsed.activeState === "active";
  const detail = parsed.loadState === "not-found"
    ? "unit not found by systemd; run relaymux restart-launch-agent"
    : parsed.result && parsed.result !== "success"
      ? `last result: ${parsed.result}`
      : "";
  return {
    ...base,
    loaded: active,
    running: active,
    state: parsed.activeState || parsed.loadState || "unknown",
    detail,
    ...parsed,
  };
}

export function parseSystemctlShow(output) {
  const properties: Record<string, string> = {};
  for (const line of String(output || "").split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    properties[line.slice(0, index)] = line.slice(index + 1);
  }
  const pid = Number(properties.MainPID || 0);
  const execStatus = properties.ExecMainStatus || "";
  return {
    loadState: properties.LoadState || "",
    activeState: properties.ActiveState || "",
    subState: properties.SubState || "",
    unitFileState: properties.UnitFileState || "",
    fragmentPath: properties.FragmentPath || "",
    result: properties.Result || "",
    pid: Number.isFinite(pid) && pid > 0 ? pid : null,
    lastExitCode: execStatus && execStatus !== "0" ? execStatus : "",
  };
}

function unsupportedBackgroundServiceStatus(config, platform, env = process.env) {
  const servicePath = backgroundServicePath(config, { platform, env });
  return {
    label: launchAgentLabel(config),
    plistPath: servicePath,
    plistExists: fs.existsSync(servicePath),
    target: "",
    supported: false,
    serviceManager: "unsupported",
    mode: "direct",
    background: true,
    loaded: false,
    running: false,
    state: "unsupported",
    detail: `No relaymux background service manager is implemented for ${platform}. Run relaymux daemon manually or use an external service manager.`,
  };
}

function getLaunchAgentStatusFor({ label, plistPath, target, platform = process.platform }) {
  const plistExists = fs.existsSync(plistPath);
  const base = { label, plistPath, plistExists, target, supported: platform === "darwin", serviceManager: "launchd", mode: "direct", background: true };
  if (!base.supported) {
    return { ...base, loaded: false, running: false, state: "unsupported" };
  }

  const result = runCommand("launchctl", ["print", target], { allowFailure: true });
  if (result.status !== 0) {
    return {
      ...base,
      loaded: false,
      running: false,
      state: "not-loaded",
      detail: firstLine(result.stderr) || firstLine(result.stdout),
    };
  }

  const parsed = parseLaunchCtlPrint(result.stdout);
  return {
    ...base,
    loaded: true,
    running: Boolean(parsed.pid),
    ...parsed,
  };
}

export function uninstallLaunchAgent({ config, io, platform = process.platform }) {
  if (platform === "linux") {
    return uninstallSystemdUserService({ config, io, env: io.env || process.env });
  }
  if (platform !== "darwin") {
    const servicePath = backgroundServicePath(config, { platform, env: io.env || process.env });
    io.stdout.write(`No supported relaymux background service manager on ${platform}; nothing installed by relaymux at ${servicePath}\n`);
    return servicePath;
  }

  const watchdogPlistPath = launchAgentWatchdogPath(config);
  if (fs.existsSync(watchdogPlistPath)) {
    runCommand("launchctl", ["bootout", launchAgentWatchdogTarget(config)], { allowFailure: true });
    fs.unlinkSync(watchdogPlistPath);
    io.stdout.write(`Removed ${watchdogPlistPath}\n`);
  }

  const watchdogScriptPath = launchAgentWatchdogScriptPath(config);
  if (fs.existsSync(watchdogScriptPath)) {
    fs.unlinkSync(watchdogScriptPath);
    io.stdout.write(`Removed ${watchdogScriptPath}\n`);
  }

  const plistPath = launchAgentPath(config);
  if (fs.existsSync(plistPath)) {
    runCommand("launchctl", ["bootout", launchAgentTarget(config)], { allowFailure: true });
    fs.unlinkSync(plistPath);
    io.stdout.write(`Removed ${plistPath}\n`);
  } else {
    io.stdout.write(`No LaunchAgent found at ${plistPath}\n`);
  }
  return plistPath;
}

function uninstallSystemdUserService({ config, io, env = process.env }) {
  const serviceName = systemdServiceName(config);
  const unitPath = systemdUserUnitPath(config, env);
  const stop = runCommand("systemctl", ["--user", "disable", "--now", serviceName], { allowFailure: true });
  if (stop.status !== 0 && !isSystemdUserUnavailable(stop)) {
    io.stderr.write(`relaymux: systemctl --user disable --now ${serviceName} failed: ${systemdFailureDetail(stop)}\n`);
  }

  if (fs.existsSync(unitPath)) {
    fs.unlinkSync(unitPath);
    io.stdout.write(`Removed ${unitPath}\n`);
  } else {
    io.stdout.write(`No systemd user unit found at ${unitPath}\n`);
  }

  const reload = runCommand("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
  if (reload.status !== 0 && !isSystemdUserUnavailable(reload)) {
    io.stderr.write(`relaymux: systemctl --user daemon-reload failed: ${systemdFailureDetail(reload)}\n`);
  }
  return unitPath;
}

export function isCurrentLaunchAgent(config, env = process.env) {
  const label = launchAgentLabel(config);
  return env.XPC_SERVICE_NAME === label || env.LAUNCHD_JOB_LABEL === label;
}

export function scheduleLaunchAgentReloadHelper({ config, plistPath, io }) {
  const mainLabel = launchAgentLabel(config);
  const helperLabel = `${mainLabel}.reload.${process.pid}.${Date.now()}`;
  const helperPlistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${helperLabel}.plist`);
  const logDir = resolveLogDir(config);
  const scriptPath = path.join(logDir, `${helperLabel}.sh`);
  const logPath = path.join(logDir, "launch-agent-reload.log");
  const domain = launchAgentDomain();
  const target = launchAgentTarget(config);
  const helperTarget = `${domain}/${helperLabel}`;
  const delaySeconds = Math.max(1, Math.ceil(Number(config.daemon?.selfRestartDelayMs || 30000) / 1000));

  ensureDirectory(path.dirname(helperPlistPath));
  ensureDirectory(logDir);
  fs.writeFileSync(scriptPath, renderLaunchAgentReloadScript({
    delaySeconds,
    domain,
    helperPlistPath,
    helperTarget,
    plistPath,
    scriptPath,
    target,
  }), { mode: 0o700 });
  try { fs.chmodSync(scriptPath, 0o700); } catch {}

  const helperPlist = renderLaunchAgentPlist({
    label: helperLabel,
    programArguments: ["/bin/sh", scriptPath],
    workingDirectory: os.homedir(),
    environment: {
      PATH: defaultLaunchPath(),
      HOME: os.homedir(),
    },
    standardOutPath: logPath,
    standardErrorPath: logPath,
    keepAlive: false,
  });
  fs.writeFileSync(helperPlistPath, helperPlist, { mode: 0o644 });

  runCommand("launchctl", ["bootout", helperTarget], { allowFailure: true });
  const result = runCommand("launchctl", ["bootstrap", domain, helperPlistPath], { allowFailure: true });
  if (result.status !== 0) {
    throw new Error(`Could not schedule LaunchAgent reload helper (${result.status}): ${firstLine(result.stderr) || firstLine(result.stdout)}`);
  }
  runCommand("launchctl", ["kickstart", "-k", helperTarget], { allowFailure: true });
  io.stdout.write(`Scheduled LaunchAgent reload helper ${helperLabel} in ${delaySeconds}s; log ${logPath}\n`);
  return helperPlistPath;
}

export function renderLaunchAgentReloadScript({ delaySeconds, domain, helperPlistPath, helperTarget, plistPath, scriptPath, target }) {
  return [
    "#!/bin/sh",
    "set -u",
    `sleep ${Math.max(1, Number(delaySeconds) || 1)}`,
    `printf '[%s] reloading %s from %s\\n' "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" ${quoteArgv([target])} ${quoteArgv([plistPath])}`,
    `${quoteArgv(["launchctl", "bootout", target])} >/dev/null 2>&1 || true`,
    "sleep 1",
    `${quoteArgv(["launchctl", "enable", target])} >/dev/null 2>&1 || true`,
    `if ${quoteArgv(["launchctl", "bootstrap", domain, plistPath])}; then`,
    `  ${quoteArgv(["launchctl", "kickstart", "-k", target])} >/dev/null 2>&1 || true`,
    `  ${quoteArgv(["launchctl", "print", target])} || true`,
    "else",
    "  status=$?",
    "  echo \"bootstrap failed with status $status\"",
    `  ${quoteArgv(["launchctl", "print", target])} || true`,
    "  exit \"$status\"",
    "fi",
    `${quoteArgv(["rm", "-f", helperPlistPath, scriptPath])} || true`,
    `${quoteArgv(["launchctl", "bootout", helperTarget])} >/dev/null 2>&1 || true`,
  ].join("\n") + "\n";
}

export function launchAgentDomain() {
  return `gui/${process.getuid?.() || 501}`;
}

export function launchAgentTarget(config) {
  return `${launchAgentDomain()}/${launchAgentLabel(config)}`;
}

export function launchAgentWatchdogTarget(config) {
  return `${launchAgentDomain()}/${launchAgentWatchdogLabel(config)}`;
}

export function shouldInstallWatchdog(config, flags: any = {}) {
  if (flags.watchdog === false) return false;
  if (config.daemon?.enabled === false) return false;
  if (config.daemon?.watchdog?.enabled === false) return false;
  return true;
}

export function launchAgentWatchdogScriptPath(config) {
  const logDir = resolveLogDir(config);
  const relaymuxHome = path.dirname(logDir);
  return path.join(relaymuxHome, "bin", `${launchAgentLabel(config)}-watchdog.sh`);
}

export function launchAgentWatchdogIntervalSeconds(config) {
  const raw = config.daemon?.watchdog?.intervalSeconds ?? config.daemon?.watchdogIntervalSeconds ?? 60;
  const interval = Number(raw);
  if (!Number.isFinite(interval) || interval <= 0) return 60;
  return Math.max(15, Math.floor(interval));
}

export function resolveWatchdogSourcePath(binPath) {
  const candidates = [
    path.resolve(path.dirname(binPath || ""), "..", "..", "scripts", "relaymux-launch-agent-watchdog.sh"),
    path.resolve(process.cwd(), "scripts", "relaymux-launch-agent-watchdog.sh"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`Could not find relaymux watchdog script. Checked: ${candidates.join(", ")}`);
  }
  return found;
}

function buildDirectDaemonArgs({ binPath, configPath }) {
  return [stableNodePath(), binPath, "--config", configPath, "daemon"];
}

function loadLaunchAgentTarget({ target, domain, plistPath }) {
  let result: any = { status: 1, stdout: "", stderr: "" };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    runCommand("launchctl", ["enable", target], { allowFailure: true });
    result = runCommand("launchctl", ["bootstrap", domain, plistPath], { allowFailure: true });
    if (result.status === 0) {
      runCommand("launchctl", ["kickstart", "-k", target], { allowFailure: true });
      return result;
    }
    runCommand("launchctl", ["bootout", target], { allowFailure: true });
    runCommand("/bin/sleep", [String(attempt)], { allowFailure: true });
  }
  return result;
}

function loadSystemdUserService({ serviceName }) {
  const reload = runCommand("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
  if (reload.status !== 0) return reload;

  const enable = runCommand("systemctl", ["--user", "enable", serviceName], { allowFailure: true });
  if (enable.status !== 0) return enable;

  return runCommand("systemctl", ["--user", "restart", serviceName], { allowFailure: true });
}

export function stableNodePath() {
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node", process.execPath, "/usr/bin/node"]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return process.execPath;
}

function launchAgentHealthUrl(config) {
  const host = formatHostForUrl(config.daemon?.host || "127.0.0.1");
  const port = Number(config.daemon?.port || 47761);
  return `http://${host}:${port}/health`;
}

function formatHostForUrl(host) {
  const value = String(host || "").trim();
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

function resolveLaunchMode(flags, config) {
  const explicitMode = flags.mode || flags.launchMode;
  const rawMode = String(explicitMode || config.daemon?.launchMode || "direct");
  const mode = rawMode === "background" ? "direct" : rawMode;
  if (explicitMode && !["direct", "background"].includes(String(explicitMode))) {
    throw new Error("Background service tmux mode has been removed. The relaymux daemon must run directly outside tmux; use start-tmux only for legacy manual debugging.");
  }
  if (["direct", "tmux", "supervised-tmux"].includes(mode)) {
    return "direct";
  }
  throw new Error(`Unknown daemon.launchMode "${rawMode}". Use "direct".`);
}

function launchAgentEnvironment(config, configPath) {
  const environment: Record<string, string> = {
    PATH: defaultLaunchPath(),
    HOME: os.homedir(),
    RELAYMUX_CONFIG: configPath,
    ...(config.daemon?.environment || {}),
  };

  for (const key of Object.keys(environment)) {
    if (key === "RELAYMUX_SESSION" || key.startsWith("TMUX")) {
      delete environment[key];
    }
  }
  return environment;
}

export function defaultLaunchPath() {
  const pathParts = [
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return pathParts.join(":");
}

function renderStartInterval(startInterval) {
  const interval = Number(startInterval || 0);
  if (!Number.isFinite(interval) || interval <= 0) return "";
  return `\n  <key>StartInterval</key>\n  <integer>${Math.floor(interval)}</integer>`;
}

function renderStartCalendarIntervals(startCalendarIntervals) {
  const intervals = Array.isArray(startCalendarIntervals) ? startCalendarIntervals : [];
  if (!intervals.length) return "";

  const rendered = intervals.map(renderStartCalendarIntervalDict);
  if (rendered.length === 1) {
    return `\n  <key>StartCalendarInterval</key>\n${rendered[0]}`;
  }
  return `\n  <key>StartCalendarInterval</key>\n  <array>\n${rendered.map((item) => indent(item, 4)).join("\n")}\n  </array>`;
}

function renderStartCalendarIntervalDict(interval) {
  const entries = Object.entries(interval || {})
    .filter(([key, value]) => ["Minute", "Hour", "Day", "Month", "Weekday"].includes(key) && value !== undefined && value !== null)
    .map(([key, value]) => {
      const number = Number(value);
      if (!Number.isInteger(number)) {
        throw new Error(`StartCalendarInterval ${key} must be an integer`);
      }
      return `    <key>${key}</key>\n    <integer>${number}</integer>`;
    })
    .join("\n");
  return `  <dict>${entries ? `\n${entries}\n  ` : ""}</dict>`;
}

function indent(value, spaces) {
  const prefix = " ".repeat(spaces);
  return String(value).split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function renderEnvironment(environment) {
  const entries = Object.entries(environment || {}).filter(([key, value]) => key && value !== undefined && value !== null);
  if (!entries.length) return "";

  const body = entries
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  return `\n  <key>EnvironmentVariables</key>\n  <dict>\n${body}\n  </dict>`;
}

function renderSystemdEnvironment(environment) {
  const entries = Object.entries(environment || {})
    .filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key)) && value !== undefined && value !== null);
  if (!entries.length) return "";
  return entries
    .map(([key, value]) => `Environment=${systemdUnitValue(`${key}=${value}`)}`)
    .join("\n") + "\n";
}

export function parseLaunchCtlPrint(output) {
  const pidMatch = /^\s*pid = (\d+)\s*$/m.exec(output);
  const stateMatch = /^\s*state = (.+?)\s*$/m.exec(output);
  const lastExitMatch = /^\s*last exit code = (.+?)\s*$/m.exec(output);
  return {
    pid: pidMatch ? Number(pidMatch[1]) : null,
    state: stateMatch ? stateMatch[1] : (pidMatch ? "running" : "loaded"),
    lastExitCode: lastExitMatch ? lastExitMatch[1] : "",
  };
}

function systemdUnitValue(value) {
  const text = String(value ?? "")
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n");
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '\\"')}"`;
}

function systemdFailureDetail(result) {
  if (result?.error?.code === "ENOENT") {
    return "systemctl not found on PATH; install/use systemd user services or run relaymux daemon manually";
  }
  const raw = firstLine(result?.stderr) || firstLine(result?.stdout) || result?.error?.message || `exit ${result?.status ?? 1}`;
  if (isSystemdUserUnavailable(result)) {
    return `${raw}; systemd --user is unavailable in this session. Use a normal systemd user login, ensure XDG_RUNTIME_DIR is set, consider 'loginctl enable-linger $USER' on headless servers, or run relaymux daemon manually.`;
  }
  return raw;
}

function isSystemdUserUnavailable(result) {
  const text = `${result?.stderr || ""}\n${result?.stdout || ""}\n${result?.error?.message || ""}`.toLowerCase();
  return result?.error?.code === "ENOENT"
    || text.includes("failed to connect to bus")
    || text.includes("no medium found")
    || text.includes("no such file or directory") && text.includes("bus")
    || text.includes("system has not been booted with systemd");
}

function firstLine(value) {
  return String(value || "").trim().split(/\r?\n/)[0] || "";
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
