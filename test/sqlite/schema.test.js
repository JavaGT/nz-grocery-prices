import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  applyMigrations,
  applyProjectionMigrations,
  applyAppMigrations,
  ensureMigrationTable,
  getAppliedMigrations,
} from '../../src/sqlite/schema.js';

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'schema-test-'));
  const dbPath = join(d, 'test.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  return { dir: d, db, dbPath };
}

describe('schema migrations', () => {
  it('ensureMigrationTable creates schema_migrations', () => {
    const { db, dir } = tmp();
    try {
      ensureMigrationTable(db);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
      assert.ok(tables, 'schema_migrations table exists');
      const cols = db.prepare('PRAGMA table_info(schema_migrations)').all().map(c => c.name);
      assert.ok(cols.includes('id'));
      assert.ok(cols.includes('name'));
      assert.ok(cols.includes('sql_hash'));
      assert.ok(cols.includes('applied_at'));
    } finally { db.close(); rmSync(dir, { recursive: true }); }
  });

  it('getAppliedMigrations returns empty on fresh DB with table', () => {
    const { db, dir } = tmp();
    try {
      ensureMigrationTable(db);
      const rows = getAppliedMigrations(db);
      assert.deepEqual(rows, []);
    } finally { db.close(); rmSync(dir, { recursive: true }); }
  });

  it('getAppliedMigrations returns empty on fresh DB without table (no crash)', () => {
    const { db, dir } = tmp();
    try {
      const rows = getAppliedMigrations(db);
      assert.deepEqual(rows, []);
    } finally { db.close(); rmSync(dir, { recursive: true }); }
  });

  it('applies a single migration and records it in schema_migrations', () => {
    const { db, dir } = tmp();
    const migDir = join(dir, 'migrations');
    mkdirSync(migDir, { recursive: true });
    writeFileSync(join(migDir, '001_test.sql'), 'CREATE TABLE IF NOT EXISTS widget (id INTEGER PRIMARY KEY, name TEXT)');
    try {
      ensureMigrationTable(db);
      applyMigrations(db, migDir);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='widget'").get();
      assert.ok(tables, 'widget table created');
      const applied = getAppliedMigrations(db);
      assert.equal(applied.length, 1);
      assert.equal(applied[0].name, '001_test');
      assert.equal(typeof applied[0].sql_hash, 'string');
      assert.equal(applied[0].sql_hash.length, 64);
    } finally { db.close(); rmSync(dir, { recursive: true }); }
  });

  it('applies multiple migrations in sorted order', () => {
    const { db, dir } = tmp();
    const migDir = join(dir, 'migrations');
    mkdirSync(migDir, { recursive: true });
    writeFileSync(join(migDir, '001_first.sql'), 'CREATE TABLE IF NOT EXISTS first (id INTEGER PRIMARY KEY)');
    writeFileSync(join(migDir, '002_second.sql'), 'CREATE TABLE IF NOT EXISTS second (id INTEGER PRIMARY KEY)');
    try {
      ensureMigrationTable(db);
      applyMigrations(db, migDir);
      const names = getAppliedMigrations(db).map(m => m.name);
      assert.deepEqual(names, ['001_first', '002_second']);
    } finally { db.close(); rmSync(dir, { recursive: true }); }
  });

  it('re-applying the same migration is idempotent (skipped via appliedNames)', () => {
    const { db, dir } = tmp();
    const migDir = join(dir, 'migrations');
    mkdirSync(migDir, { recursive: true });
    const sql = 'CREATE TABLE IF NOT EXISTS foo (id INTEGER PRIMARY KEY)';
    writeFileSync(join(migDir, '001_foo.sql'), sql);
    try {
      ensureMigrationTable(db);
      applyMigrations(db, migDir);
      assert.equal(getAppliedMigrations(db).length, 1);
      applyMigrations(db, migDir);
      assert.equal(getAppliedMigrations(db).length, 1, 'should still be 1 after second apply');
    } finally { db.close(); rmSync(dir, { recursive: true }); }
  });

  it('throws when a previously-applied migration file has changed SQL hash', () => {
    const { db, dir } = tmp();
    const migDir = join(dir, 'migrations');
    mkdirSync(migDir, { recursive: true });
    const file = join(migDir, '001_test.sql');
    writeFileSync(file, 'CREATE TABLE IF NOT EXISTS foo (id INTEGER PRIMARY KEY)');
    try {
      ensureMigrationTable(db);
      applyMigrations(db, migDir);
      writeFileSync(file, 'CREATE TABLE IF NOT EXISTS foo (name TEXT)');
      assert.throws(() => applyMigrations(db, migDir), {
        message: /hash/,
      });
    } finally { db.close(); rmSync(dir, { recursive: true }); }
  });

  it('applyProjectionMigrations applies 001_initial.sql from the project', () => {
    const { db, dir } = tmp();
    try {
      applyProjectionMigrations(db);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
      assert.ok(tables.includes('_meta'));
      assert.ok(tables.includes('deal_signals'));
      assert.ok(tables.includes('import_runs'));
      assert.ok(tables.includes('offer_revisions'));
      assert.ok(tables.includes('price_contexts'));
      assert.ok(tables.includes('product_matches'));
      assert.ok(tables.includes('product_revisions'));
      assert.ok(tables.includes('products'));
      assert.ok(tables.includes('retailers'));
      assert.ok(tables.includes('schema_migrations'));
      assert.ok(tables.includes('special_snapshots'));
      assert.ok(tables.includes('store_revisions'));
      const views = db.prepare("SELECT name FROM sqlite_master WHERE type='view' ORDER BY name").all().map(r => r.name);
      assert.ok(views.includes('price_observations'));
    } finally { db.close(); rmSync(dir, { recursive: true }); }
  });

  it('applyAppMigrations applies 001_app_auth.sql from the project', () => {
    const { db, dir } = tmp();
    try {
      applyAppMigrations(db);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
      assert.ok(tables.includes('users'));
      assert.ok(tables.includes('sessions'));
      assert.ok(tables.includes('user_store_preferences'));
      assert.ok(tables.includes('saved_searches'));
      assert.ok(tables.includes('watch_list_entries'));
      assert.ok(tables.includes('new_product_notices'));
      assert.ok(tables.includes('rate_limit'));
      assert.ok(tables.includes('product_match_pairs'));
      const applied = getAppliedMigrations(db);
      assert.equal(applied.length, 2);
      assert.equal(applied[0].name, '001_app_auth');
      assert.equal(applied[1].name, '002_product_matching');
    } finally { db.close(); rmSync(dir, { recursive: true }); }
  });

  it('000_initial runs all CREATE TABLE IF NOT EXISTS statements without error', () => {
    const { db, dir } = tmp();
    try {
      applyProjectionMigrations(db);
      const applied = getAppliedMigrations(db);
      assert.equal(applied.length, 1);
      assert.equal(applied[0].name, '001_initial');
    } finally { db.close(); rmSync(dir, { recursive: true }); }
  });

  it('handles non-.sql files — only .sql files are loaded (hidden .sql files are excluded)', () => {
    const { db, dir } = tmp();
    const migDir = join(dir, 'migrations');
    mkdirSync(migDir, { recursive: true });
    writeFileSync(join(migDir, '001_real.sql'), 'CREATE TABLE IF NOT EXISTS real (id INT)');
    writeFileSync(join(migDir, 'readme.txt'), 'not a migration');
    writeFileSync(join(migDir, '.hidden.sql'), 'CREATE TABLE IF NOT EXISTS hidden (id INT)');
    try {
      ensureMigrationTable(db);
      applyMigrations(db, migDir);
      const names = getAppliedMigrations(db).map(m => m.name);
      assert.ok(names.includes('001_real'), 'real migration applied');
      assert.equal(names.filter(n => n === '.hidden').length, 0, 'hidden .sql is NOT applied (dotfiles excluded)');
      assert.equal(names.filter(n => n === 'readme').length, 0, 'readme.txt not applied');
    } finally { db.close(); rmSync(dir, { recursive: true }); }
  });

  it('migration failure — first good migration is committed before bad migration fails', () => {
    const { db, dir } = tmp();
    const migDir = join(dir, 'migrations');
    mkdirSync(migDir, { recursive: true });
    writeFileSync(join(migDir, '001_good.sql'), 'CREATE TABLE IF NOT EXISTS good (id INT)');
    writeFileSync(join(migDir, '002_bad.sql'), 'CREATE TABLE invalid SQL syntax(((');
    try {
      ensureMigrationTable(db);
      assert.throws(() => applyMigrations(db, migDir));
      const applied = getAppliedMigrations(db);
      assert.equal(applied.length, 1, '001_good was committed before 002_bad failed (migrations are not wrapped in a single transaction)');
      assert.equal(applied[0].name, '001_good');
    } finally { db.close(); rmSync(dir, { recursive: true }); }
  });

  it('applyMigrations logs migrations (verify no crash on log output)', () => {
    const { db, dir } = tmp();
    const migDir = join(dir, 'migrations');
    mkdirSync(migDir, { recursive: true });
    writeFileSync(join(migDir, '001_a.sql'), 'CREATE TABLE IF NOT EXISTS aaa (id INT)');
    const origConsole = console.error;
    const logs = [];
    console.error = (...args) => logs.push(args.join(' '));
    try {
      ensureMigrationTable(db);
      applyMigrations(db, migDir);
      assert.ok(logs.some(l => l.includes('[migrate] Applied 001_a')), 'expected log entry');
    } finally {
      console.error = origConsole;
      db.close(); rmSync(dir, { recursive: true });
    }
  });
});
