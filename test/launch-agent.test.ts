import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import {
  formatLaunchAgentLoadFailure,
  formatSystemdServiceLoadFailure,
  installLaunchAgent,
  isCurrentLaunchAgent,
  parseLaunchCtlPrint,
  parseSystemctlShow,
  renderLaunchAgentPlist,
  renderLaunchAgentReloadScript,
  renderLaunchAgentWatchdogPlist,
  renderSystemdUserServiceUnit,
  resolveWatchdogSourcePath,
  shouldInstallWatchdog,
  systemdServiceName,
} from "../src/launch-agent.js";


test("renderLaunchAgentPlist escapes XML and includes daemon args", () => {
  const plist = renderLaunchAgentPlist({
    label: "com.example.relaymux",
    programArguments: ["/bin/node", "/tmp/a&b/relaymux", "daemon"],
    workingDirectory: "/tmp/work",
    standardOutPath: "/tmp/out.log",
    standardErrorPath: "/tmp/err.log",
  });

  assert.match(plist, /<string>com.example.relaymux<\/string>/);
  assert.match(plist, /a&amp;b/);
  assert.match(plist, /<string>daemon<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>/);
});

test("renderLaunchAgentPlist can include launch environment", () => {
  const plist = renderLaunchAgentPlist({
    label: "com.example.relaymux",
    programArguments: ["/bin/node", "/tmp/relaymux", "daemon", "--session", "agents"],
    workingDirectory: "/tmp/work",
    standardOutPath: "/tmp/out.log",
    standardErrorPath: "/tmp/err.log",
    environment: {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      RELAYMUX_SESSION: "agents",
    },
  });

  assert.match(plist, /<key>EnvironmentVariables<\/key>/);
  assert.match(plist, /<key>PATH<\/key>/);
  assert.match(plist, /<string>daemon<\/string>/);
  assert.match(plist, /<key>RELAYMUX_SESSION<\/key>/);
});

test("renderLaunchAgentPlist can include a start interval", () => {
  const plist = renderLaunchAgentPlist({
    label: "com.example.relaymux.watchdog",
    programArguments: ["/bin/sh", "/tmp/watchdog.sh"],
    workingDirectory: "/tmp/work",
    standardOutPath: "/tmp/out.log",
    standardErrorPath: "/tmp/err.log",
    keepAlive: false,
    startInterval: 60,
  });

  assert.match(plist, /<key>KeepAlive<\/key>\n  <false\/>/);
  assert.match(plist, /<key>StartInterval<\/key>/);
  assert.match(plist, /<integer>60<\/integer>/);
});

test("renderSystemdUserServiceUnit runs the daemon directly with restart policy", () => {
  const unit = renderSystemdUserServiceUnit({
    serviceName: "com.example.relaymux.service",
    programArguments: ["/usr/bin/node", "/opt/relaymux/relaymux.js", "--config", "/tmp/relaymux config.json", "daemon"],
    workingDirectory: "/tmp/work dir",
    standardOutPath: "/tmp/relaymux/daemon.out.log",
    standardErrorPath: "/tmp/relaymux/daemon.err.log",
    environment: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      RELAYMUX_CONFIG: "/tmp/relaymux config.json",
    },
  });

  assert.match(unit, /\[Service\]/);
  assert.match(unit, /Type=simple/);
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/relaymux\/relaymux\.js --config "\/tmp\/relaymux config\.json" daemon/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /Environment=PATH=\/usr\/local\/bin:\/usr\/bin:\/bin/);
  assert.match(unit, /StandardOutput=append:\/tmp\/relaymux\/daemon\.out\.log/);
});

test("renderLaunchAgentPlist can include launchd calendar intervals", () => {
  const plist = renderLaunchAgentPlist({
    label: "com.example.relaymux.schedule.daily",
    programArguments: ["/usr/bin/node", "/tmp/relaymux.js", "ask", "--no-wait"],
    workingDirectory: "/tmp/work",
    standardOutPath: "/tmp/out.log",
    standardErrorPath: "/tmp/err.log",
    keepAlive: false,
    runAtLoad: false,
    startCalendarIntervals: [{ Minute: 0, Hour: 9 }],
  });

  assert.match(plist, /<key>RunAtLoad<\/key>\n  <false\/>/);
  assert.match(plist, /<key>StartCalendarInterval<\/key>/);
  assert.match(plist, /<key>Minute<\/key>\n    <integer>0<\/integer>/);
  assert.match(plist, /<key>Hour<\/key>\n    <integer>9<\/integer>/);
});

test("renderLaunchAgentWatchdogPlist points at the main daemon and health endpoint", () => {
  const base = defaultConfig();
  const config = {
    ...base,
    daemon: {
      ...base.daemon,
      launchAgentLabel: "com.example.relaymux",
      port: 49999,
      watchdog: { enabled: true, intervalSeconds: 45 },
    },
  };
  const plist = renderLaunchAgentWatchdogPlist({
    config,
    configPath: "/tmp/relaymux-config.json",
    scriptPath: "/tmp/watchdog.sh",
  });

  assert.match(plist, /<string>com.example.relaymux.watchdog<\/string>/);
  assert.match(plist, /<string>\/tmp\/watchdog.sh<\/string>/);
  assert.match(plist, /<key>RELAYMUX_MAIN_LABEL<\/key>/);
  assert.match(plist, /<string>com.example.relaymux<\/string>/);
  assert.match(plist, /<key>RELAYMUX_HEALTH_URL<\/key>/);
  assert.match(plist, /http:\/\/127\.0\.0\.1:49999\/health/);
  assert.match(plist, /<integer>45<\/integer>/);
});

test("watchdog install defaults on and can be disabled", () => {
  const config = defaultConfig();
  assert.equal(shouldInstallWatchdog(config, {}), true);
  assert.equal(shouldInstallWatchdog(config, { watchdog: false }), false);
  assert.equal(shouldInstallWatchdog({ ...config, daemon: { ...config.daemon, watchdog: { enabled: false } } }, {}), false);
});

test("resolveWatchdogSourcePath finds the checked-in script", () => {
  const resolved = resolveWatchdogSourcePath("/tmp/nonexistent/dist/bin/relaymux.js");
  assert.match(resolved, /scripts\/relaymux-launch-agent-watchdog\.sh$/);
});

test("installLaunchAgent direct dry-run does not invoke tmux or set tmux environment", () => {
  let stdout = "";
  const base = defaultConfig();
  const config = {
    ...base,
    daemon: {
      ...base.daemon,
      environment: {
        TMUX_TMPDIR: "/tmp/should-be-filtered",
        RELAYMUX_SESSION: "should-be-filtered",
      },
    },
  };

  installLaunchAgent({
    flags: { dryRun: true },
    configInfo: { config, path: "/tmp/relaymux-config.json", exists: true },
    binPath: "/tmp/relaymux.js",
    platform: "darwin",
    io: {
      stdout: { write: (chunk) => { stdout += String(chunk); } },
      stderr: { write: () => {} },
    },
  });

  assert.match(stdout, /<string>daemon<\/string>/);
  assert.doesNotMatch(stdout, /supervise-tmux/);
  assert.doesNotMatch(stdout, /start-tmux/);
  assert.doesNotMatch(stdout, /<string>tmux<\/string>/);
  assert.doesNotMatch(stdout, /TMUX/);
  assert.doesNotMatch(stdout, /RELAYMUX_SESSION/);
});

test("installLaunchAgent dry-run emits a systemd user unit on Linux", () => {
  let stdout = "";
  const config = {
    ...defaultConfig(),
    daemon: {
      ...defaultConfig().daemon,
      launchAgentLabel: "com.example.relaymux",
    },
  };

  installLaunchAgent({
    flags: { dryRun: true },
    configInfo: { config, path: "/tmp/relaymux-config.json", exists: true },
    binPath: "/tmp/relaymux.js",
    platform: "linux",
    io: {
      env: { XDG_CONFIG_HOME: "/tmp/xdg" },
      stdout: { write: (chunk) => { stdout += String(chunk); } },
      stderr: { write: () => {} },
    },
  });

  assert.match(stdout, /\[Unit\]/);
  assert.match(stdout, /ExecStart=.*relaymux\.js.*daemon/);
  assert.match(stdout, /Restart=always/);
  assert.doesNotMatch(stdout, /<plist/);
  assert.doesNotMatch(stdout, /launchctl/);
});

test("systemdServiceName reuses the configured label with a service suffix", () => {
  const config = {
    ...defaultConfig(),
    daemon: {
      ...defaultConfig().daemon,
      launchAgentLabel: "com.example.relaymux",
    },
  };

  assert.equal(systemdServiceName(config), "com.example.relaymux.service");
});

test("isCurrentLaunchAgent detects inherited launchd service context", () => {
  const config = {
    ...defaultConfig(),
    daemon: {
      ...defaultConfig().daemon,
      launchAgentLabel: "com.example.relaymux",
    },
  };

  assert.equal(isCurrentLaunchAgent(config, { XPC_SERVICE_NAME: "com.example.relaymux" }), true);
  assert.equal(isCurrentLaunchAgent(config, { XPC_SERVICE_NAME: "com.example.other" }), false);
});

test("renderLaunchAgentReloadScript bootouts and bootstraps the main service", () => {
  const script = renderLaunchAgentReloadScript({
    delaySeconds: 15,
    domain: "gui/501",
    helperPlistPath: "/tmp/helper.plist",
    helperTarget: "gui/501/com.example.relaymux.reload.1",
    plistPath: "/tmp/main.plist",
    scriptPath: "/tmp/helper.sh",
    target: "gui/501/com.example.relaymux",
  });

  assert.match(script, /sleep 15/);
  assert.match(script, /launchctl bootout gui\/501\/com.example.relaymux/);
  assert.match(script, /launchctl bootstrap gui\/501 \/tmp\/main.plist/);
  assert.match(script, /com.example.relaymux.reload.1/);
});

test("parseLaunchCtlPrint extracts running status", () => {
  const status = parseLaunchCtlPrint(`state = running\n\tpid = 1234\n\tlast exit code = 0\n`);

  assert.equal(status.state, "running");
  assert.equal(status.pid, 1234);
  assert.equal(status.lastExitCode, "0");
});

test("parseSystemctlShow extracts active service status", () => {
  const status = parseSystemctlShow([
    "LoadState=loaded",
    "ActiveState=active",
    "SubState=running",
    "MainPID=4321",
    "ExecMainStatus=0",
  ].join("\n"));

  assert.equal(status.loadState, "loaded");
  assert.equal(status.activeState, "active");
  assert.equal(status.subState, "running");
  assert.equal(status.pid, 4321);
  assert.equal(status.lastExitCode, "");
});

test("formatLaunchAgentLoadFailure includes actionable launchctl context", () => {
  const text = formatLaunchAgentLoadFailure({
    label: "com.example.relaymux",
    result: { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Bad request.\n" },
    domain: "gui/501",
    target: "gui/501/com.example.relaymux",
    plistPath: "/Users/example/Library/LaunchAgents/com.example.relaymux.plist",
    logDir: "/Users/example/.relaymux/logs",
    stdoutLog: "/Users/example/.relaymux/logs/daemon.out.log",
    stderrLog: "/Users/example/.relaymux/logs/daemon.err.log",
  });

  assert.match(text, /Bad request/);
  assert.match(text, /plist: \/Users\/example\/Library\/LaunchAgents\/com\.example\.relaymux\.plist/);
  assert.match(text, /daemon\.out\.log/);
  assert.match(text, /launchctl print gui\/501\/com\.example\.relaymux/);
  assert.match(text, /common causes/);
  assert.match(text, /relaymux restart-launch-agent/);
});

test("formatSystemdServiceLoadFailure includes actionable systemd context", () => {
  const text = formatSystemdServiceLoadFailure({
    serviceName: "com.example.relaymux.service",
    result: { status: 1, stdout: "", stderr: "Failed to connect to bus: No medium found\n" },
    unitPath: "/home/example/.config/systemd/user/com.example.relaymux.service",
    logDir: "/home/example/.relaymux/logs",
    stdoutLog: "/home/example/.relaymux/logs/daemon.out.log",
    stderrLog: "/home/example/.relaymux/logs/daemon.err.log",
  });

  assert.match(text, /systemctl --user/);
  assert.match(text, /systemd --user is unavailable/);
  assert.match(text, /unit: \/home\/example\/\.config\/systemd\/user\/com\.example\.relaymux\.service/);
  assert.match(text, /journalctl --user -u com\.example\.relaymux\.service -e/);
  assert.match(text, /fallback: run relaymux daemon/);
});
