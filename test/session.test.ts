import assert from "node:assert/strict";
import test from "node:test";

import { deriveFeatureSessionName, resolveLaunchSession, resolveTmuxSessionMode } from "../src/session.js";

test("deriveFeatureSessionName is deterministic, safe, short, and branch-sensitive", () => {
  const first = deriveFeatureSessionName({
    prefix: "rmx",
    repo: "/tmp/my repo",
    workdir: "/tmp/my repo/worktrees/api fix",
    branch: "feature/api fix",
    name: "fix api",
  });
  const second = deriveFeatureSessionName({
    prefix: "rmx",
    repo: "/tmp/my repo",
    workdir: "/tmp/my repo/worktrees/api fix",
    branch: "feature/api fix",
    name: "fix api",
  });
  const other = deriveFeatureSessionName({
    prefix: "rmx",
    repo: "/tmp/my repo",
    workdir: "/tmp/my repo/worktrees/api fix",
    branch: "feature/other",
    name: "fix api",
  });
  const sameWorktreeDifferentName = deriveFeatureSessionName({
    prefix: "rmx",
    repo: "/tmp/my repo",
    workdir: "/tmp/my repo/worktrees/api fix",
    name: "different agent name",
  });
  const sameWorktreeNoName = deriveFeatureSessionName({
    prefix: "rmx",
    repo: "/tmp/my repo",
    workdir: "/tmp/my repo/worktrees/api fix",
  });

  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.equal(sameWorktreeDifferentName, sameWorktreeNoName);
  assert.match(first, /^[A-Za-z0-9_.-]+$/);
  assert.match(sameWorktreeDifferentName, /^[A-Za-z0-9_.-]+$/);
  assert.ok(first.length <= 64);
});

test("resolveLaunchSession defaults to shared and honors explicit/per-worktree escape hatches", () => {
  const config = { session: "shared-agents", tmux: { sessionPrefix: "rmx" } };

  assert.equal(resolveTmuxSessionMode({}), "shared");

  const sharedFromEnv = resolveLaunchSession({
    flags: { worktreeBranch: "feature/api" },
    config,
    env: { RELAYMUX_SESSION: "env-agents" },
    repo: "/tmp/repo",
    workdir: "/tmp/repo-api",
    name: "api",
  });
  assert.deepEqual(sharedFromEnv, { session: "env-agents", mode: "shared", source: "RELAYMUX_SESSION" });

  const sharedFromConfig = resolveLaunchSession({
    flags: { worktreeBranch: "feature/api" },
    config,
    env: {},
    repo: "/tmp/repo",
    workdir: "/tmp/repo-api",
    name: "api",
  });
  assert.deepEqual(sharedFromConfig, { session: "shared-agents", mode: "shared", source: "config.session" });

  const explicit = resolveLaunchSession({
    flags: { session: "manual-group" },
    config,
    env: {},
    repo: "/tmp/repo",
    workdir: "/tmp/repo-api",
    name: "api",
  });
  assert.deepEqual(explicit, { session: "manual-group", mode: "explicit", source: "--session" });

  const perWorktree = resolveLaunchSession({
    flags: { sessionMode: "per-worktree", worktreeBranch: "feature/api" },
    config,
    env: { RELAYMUX_SESSION: "ignored-env" },
    repo: "/tmp/repo",
    workdir: "/tmp/repo-api",
    name: "api",
  });
  assert.equal(perWorktree.mode, "per-worktree");
  assert.notEqual(perWorktree.session, "shared-agents");
  assert.notEqual(perWorktree.session, "ignored-env");

  assert.equal(resolveTmuxSessionMode({ config: { tmux: { sessionMode: "per-worktree" } } }), "per-worktree");
});
