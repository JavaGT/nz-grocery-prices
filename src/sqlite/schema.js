import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function sqlHash(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

export function getAppliedMigrations(db) {
  try {
    return db.prepare('SELECT name, sql_hash FROM schema_migrations ORDER BY id').all();
  } catch {
    return [];
  }
}

export function applyMigrations(db, migrationsDir) {
  const applied = getAppliedMigrations(db);
  const appliedNames = new Set(applied.map(m => m.name));
  const appliedHashes = new Map(applied.map(m => [m.name, m.sql_hash]));

  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql') && !f.startsWith('.'))
    .sort();

  for (const file of files) {
    const name = file.replace(/\.sql$/, '');
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const hash = sqlHash(sql);

    if (appliedNames.has(name)) {
      const existingHash = appliedHashes.get(name);
      if (existingHash !== hash) {
        throw new Error(
          `Migration ${file} has been applied with hash ${existingHash} ` +
          `but file now has hash ${hash}. Changed applied migrations are not allowed.`
        );
      }
      continue;
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const startMs = Date.now();
      db.exec(sql);
      const duration = Date.now() - startMs;

      db.prepare(
        "INSERT INTO schema_migrations(name, sql_hash) VALUES(?, ?)"
      ).run(name, hash);

      db.exec('COMMIT');
      console.error(`[migrate] Applied ${name} (${duration}ms)`);
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore rollback error */ }
      throw err;
    }
  }
}

export function applyProjectionMigrations(db) {
  const { url } = import.meta;
  const dir = new URL('./migrations/projection/', url).pathname;
  applyMigrations(db, dir);
}

export function applyAppMigrations(db) {
  const { url } = import.meta;
  const dir = new URL('./migrations/app/', url).pathname;
  applyMigrations(db, dir);
}

export function ensureMigrationTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    sql_hash    TEXT NOT NULL,
    applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`);
}
