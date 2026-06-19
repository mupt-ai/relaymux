import fs from "node:fs";
import path from "node:path";

import { defaultRelaymuxDatabasePath, ensureDirectory } from "./paths.js";
import { runCommand } from "./process.js";

export const RELAYMUX_DB_MIGRATIONS = [
  {
    version: 1,
    name: "core_metadata",
    statements: [
      `CREATE TABLE IF NOT EXISTS relaymux_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
)`,
    ],
  },
  {
    version: 2,
    name: "runs_events",
    statements: [
      `CREATE TABLE IF NOT EXISTS relaymux_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  agent TEXT,
  name TEXT,
  session TEXT,
  session_mode TEXT,
  session_source TEXT,
  target TEXT,
  window_target TEXT,
  repo TEXT,
  workdir TEXT,
  prompt_file TEXT,
  script_file TEXT,
  command TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}'
)`,
      "CREATE INDEX IF NOT EXISTS relaymux_runs_started_at_idx ON relaymux_runs(started_at)",
      "CREATE INDEX IF NOT EXISTS relaymux_runs_agent_idx ON relaymux_runs(agent)",
      `CREATE TABLE IF NOT EXISTS relaymux_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  time TEXT NOT NULL,
  event TEXT NOT NULL,
  message TEXT,
  exit_code INTEGER,
  payload_json TEXT NOT NULL DEFAULT '{}'
)`,
      "CREATE INDEX IF NOT EXISTS relaymux_events_run_id_idx ON relaymux_events(run_id)",
      "CREATE INDEX IF NOT EXISTS relaymux_events_time_idx ON relaymux_events(time)",
    ],
  },
];

export function relaymuxDbPath(env = process.env) {
  return defaultRelaymuxDatabasePath(env);
}

export function findSqliteCli(env = process.env) {
  return findExecutable("sqlite3", env);
}

export function initRelaymuxDb(options: any = {}) {
  const env = options.env || process.env;
  const dbPath = options.dbPath || relaymuxDbPath(env);
  const sqlitePath = resolveSqlitePath(options, env);
  const runner = options.runCommand || runCommand;

  ensureDirectory(path.dirname(dbPath));
  runSqlite(sqlitePath, dbPath, bootstrapSql(), { runner, env });

  const before = readAppliedMigrations({ dbPath, sqlitePath, runner, env });
  const appliedByVersion = new Map<number, any>(before.map((migration) => [migration.version, migration]));
  const applied: any[] = [];

  for (const migration of RELAYMUX_DB_MIGRATIONS) {
    const existing = appliedByVersion.get(migration.version);
    if (existing) {
      if (existing.name !== migration.name) {
        throw new Error(`SQLite migration version ${migration.version} is named ${existing.name}, expected ${migration.name}`);
      }
      continue;
    }

    runSqlite(sqlitePath, dbPath, migrationSql(migration), { runner, env });
    applied.push({ version: migration.version, name: migration.name });
  }

  writeSchemaVersionMetadata({ dbPath, sqlitePath, runner, env });
  const migrations = readAppliedMigrations({ dbPath, sqlitePath, runner, env });
  return {
    dbPath,
    sqlitePath,
    applied,
    migrations,
    currentVersion: currentVersion(migrations),
    expectedVersion: expectedVersion(),
  };
}

export function relaymuxDbStatus(options: any = {}) {
  const env = options.env || process.env;
  const dbPath = options.dbPath || relaymuxDbPath(env);
  const sqlitePath = options.sqlitePath || findSqliteCli(env);
  const exists = fs.existsSync(dbPath);
  const status: any = {
    dbPath,
    sqlite: {
      available: Boolean(sqlitePath),
      path: sqlitePath || "",
    },
    exists,
    initialized: false,
    migrations: [],
    currentVersion: 0,
    expectedVersion: expectedVersion(),
    pending: RELAYMUX_DB_MIGRATIONS.map(({ version, name }) => ({ version, name })),
    error: "",
  };

  if (!sqlitePath || !exists) {
    return status;
  }

  const runner = options.runCommand || runCommand;
  try {
    const hasTable = queryScalar(sqlitePath, dbPath, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'relaymux_schema_migrations';", { runner, env });
    if (hasTable !== "relaymux_schema_migrations") {
      return status;
    }

    const migrations = readAppliedMigrations({ dbPath, sqlitePath, runner, env });
    const appliedVersions = new Set(migrations.map((migration) => migration.version));
    status.initialized = true;
    status.migrations = migrations;
    status.currentVersion = currentVersion(migrations);
    status.pending = RELAYMUX_DB_MIGRATIONS
      .filter((migration) => !appliedVersions.has(migration.version))
      .map(({ version, name }) => ({ version, name }));
  } catch (error) {
    status.error = error.message;
  }

  return status;
}

export function expectedSchemaSql() {
  const chunks = [bootstrapSql().trim()];
  for (const migration of RELAYMUX_DB_MIGRATIONS) {
    chunks.push(`-- migration ${migration.version}: ${migration.name}`);
    chunks.push(migration.statements.map((statement) => `${statement};`).join("\n"));
  }
  return `${chunks.join("\n\n")}\n`;
}

function resolveSqlitePath(options, env) {
  const sqlitePath = options.sqlitePath || findSqliteCli(env);
  if (!sqlitePath) {
    throw new Error(`sqlite3 CLI not found on PATH; install sqlite3 to use relaymux db commands. DB path: ${relaymuxDbPath(env)}`);
  }
  return sqlitePath;
}

function bootstrapSql() {
  return [
    ".bail on",
    "PRAGMA journal_mode = WAL;",
    `CREATE TABLE IF NOT EXISTS relaymux_schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
);`,
  ].join("\n");
}

function migrationSql(migration) {
  return [
    ".bail on",
    "PRAGMA foreign_keys = ON;",
    "BEGIN IMMEDIATE;",
    ...migration.statements.map((statement) => `${statement};`),
    `INSERT INTO relaymux_schema_migrations(version, name, applied_at)
VALUES (${migration.version}, '${escapeSql(migration.name)}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));`,
    "COMMIT;",
  ].join("\n");
}

function writeSchemaVersionMetadata({ dbPath, sqlitePath, runner, env }) {
  runSqlite(sqlitePath, dbPath, [
    ".bail on",
    `INSERT INTO relaymux_metadata(key, value, updated_at)
VALUES ('schema_version', '${expectedVersion()}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
  ].join("\n"), { runner, env });
}

function readAppliedMigrations({ dbPath, sqlitePath, runner, env }) {
  const output = query(sqlitePath, dbPath, [
    ".mode tabs",
    "SELECT version, name, applied_at FROM relaymux_schema_migrations ORDER BY version;",
  ].join("\n"), { runner, env });

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [version, name, appliedAt] = line.split("\t");
      return {
        version: Number(version),
        name,
        appliedAt,
      };
    })
    .filter((migration) => Number.isFinite(migration.version) && migration.name);
}

function queryScalar(sqlitePath, dbPath, sql, options) {
  return query(sqlitePath, dbPath, sql, options).trim();
}

function query(sqlitePath, dbPath, sql, { runner, env }) {
  return runSqlite(sqlitePath, dbPath, sql, { runner, env }).stdout;
}

function runSqlite(sqlitePath, dbPath, sql, { runner, env }) {
  const result = runner(sqlitePath, ["-batch", dbPath], {
    input: sql,
    env,
    allowFailure: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0 || result.error) {
    const detail = result.stderr?.trim() || result.error?.message || `sqlite3 exited with ${result.status}`;
    throw new Error(detail);
  }
  return result;
}

function currentVersion(migrations) {
  return migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
}

function expectedVersion() {
  return RELAYMUX_DB_MIGRATIONS[RELAYMUX_DB_MIGRATIONS.length - 1]?.version || 0;
}

function escapeSql(value) {
  return String(value).replace(/'/g, "''");
}

function findExecutable(command, env) {
  if (!command) return null;
  if (command.includes(path.sep)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }

  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}
