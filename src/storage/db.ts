import Database from 'better-sqlite3';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Walk up from CWD to find the nearest .step-gate/ workspace directory.
// This allows Sub Agents running from subdirectories to find the correct DB.
function findWorkspace(startDir: string): string {
  let dir = resolve(startDir);
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, '.step-gate'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: use CWD and create .step-gate there
  return startDir;
}

const WORKSPACE = findWorkspace(process.cwd());
const DB_PATH = resolve(WORKSPACE, '.step-gate', 'gate.db');

// Migrate from old package-relative DB
const __dirname = dirname(fileURLToPath(import.meta.url));
const OLD_DB = resolve(__dirname, '..', '..', 'data', 'gate.db');
if (existsSync(OLD_DB) && !existsSync(DB_PATH)) {
  try {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    copyFileSync(OLD_DB, DB_PATH);
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(OLD_DB + ext)) copyFileSync(OLD_DB + ext, DB_PATH + ext);
    }
  } catch { /* migration best-effort */ }
}

mkdirSync(dirname(DB_PATH), { recursive: true });

const db: Database.Database = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS programs (
    program_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    total_nodes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS program_nodes (
    node_id TEXT PRIMARY KEY,
    program_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    order_index INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    session_id TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(program_id) REFERENCES programs(program_id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    session_secret_hash TEXT NOT NULL,
    recovery_token_hash TEXT NOT NULL,
    title TEXT,
    workspace TEXT,
    program_id TEXT,
    program_node_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_by_cli TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(program_id) REFERENCES programs(program_id),
    FOREIGN KEY(program_node_id) REFERENCES program_nodes(node_id)
  );

  CREATE TABLE IF NOT EXISTS cli_instances (
    cli_instance_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    hostname TEXT,
    pid INTEGER,
    workspace TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(session_id)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    current_index INTEGER NOT NULL DEFAULT 0,
    total_steps INTEGER NOT NULL,
    final_key_hash TEXT,
    session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(session_id)
  );

  CREATE TABLE IF NOT EXISTS steps (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    parent_path TEXT,
    title TEXT NOT NULL,
    path TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    depends_on TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    step_key_hash TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id)
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    step_id TEXT,
    event_type TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id)
  );
`);

// Safe migrations for existing databases
for (const sql of [
  "ALTER TABLE tasks ADD COLUMN session_id TEXT",
  "ALTER TABLE sessions ADD COLUMN created_by_cli TEXT",
  "ALTER TABLE sessions ADD COLUMN workspace TEXT",
  "ALTER TABLE sessions ADD COLUMN program_id TEXT",
  "ALTER TABLE sessions ADD COLUMN program_node_id TEXT",
  "ALTER TABLE program_nodes ADD COLUMN node_key_hash TEXT",
  "ALTER TABLE program_nodes ADD COLUMN depends_on TEXT",
]) {
  try { db.exec(sql); } catch { /* column exists */ }
}

export default db;
