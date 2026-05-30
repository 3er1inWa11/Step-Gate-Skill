import crypto from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import db from '../storage/db.js';
import { randomCode } from './keys.js';

const SESSION_DIR = '.step-gate/sessions';
const BINDING_DIR = '.step-gate/bindings';

// Shared state: the single session for this MCP process.
// Created lazily on first gate_start_plan call, then shared by all tools.
let currentSessionId: string | null = null;
export function getCurrentSessionId(): string | null { return currentSessionId; }

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function now(): string {
  return new Date().toISOString();
}

export interface SessionInfo {
  sessionId: string;
  sessionSecret: string;
  recoveryToken: string;
  cliInstanceId: string;
  workspace: string;
}

/** Create a new session and write the session file. */
export function createSession(workspace: string): SessionInfo {
  const sessionId = `ses_${randomCode(6)}`;
  const sessionSecret = randomCode(6);
  const recoveryToken = randomCode(6);
  const cliInstanceId = `cli_${randomCode(6)}`;
  const ts = now();

  db.prepare(`
    INSERT INTO sessions (session_id, session_secret_hash, recovery_token_hash, workspace, created_by_cli, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, sha256(sessionSecret), sha256(recoveryToken), workspace, cliInstanceId, ts, ts);

  db.prepare(`
    INSERT INTO cli_instances (cli_instance_id, session_id, workspace, pid, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(cliInstanceId, sessionId, workspace, process.pid, ts, ts);

  currentSessionId = sessionId;

  writeSessionFile({ sessionId, sessionSecret, recoveryToken, cliInstanceId, workspace });
  writeBindingFile({ sessionId, cliInstanceId, workspace });
  return { sessionId, sessionSecret, recoveryToken, cliInstanceId, workspace };
}

/** Verify session_secret against stored hash. */
export function verifySessionSecret(sessionId: string, secret: string): boolean {
  const row = db.prepare('SELECT session_secret_hash FROM sessions WHERE session_id = ?')
    .get(sessionId) as { session_secret_hash: string } | undefined;
  if (!row) return false;
  return sha256(secret) === row.session_secret_hash;
}

/** Verify recovery_token against stored hash. */
export function verifyRecoveryToken(sessionId: string, token: string): boolean {
  const row = db.prepare('SELECT recovery_token_hash FROM sessions WHERE session_id = ?')
    .get(sessionId) as { recovery_token_hash: string } | undefined;
  if (!row) return false;
  return sha256(token) === row.recovery_token_hash;
}

/** Check if a session is still active. */
export function isSessionActive(sessionId: string): boolean {
  const row = db.prepare("SELECT status FROM sessions WHERE session_id = ?")
    .get(sessionId) as { status: string } | undefined;
  return row?.status === 'active';
}

/** Write session credentials to local file for CLI/Hook use. */
export function writeSessionFile(info: SessionInfo): void {
  const dir = resolve(info.workspace || process.cwd(), SESSION_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${info.sessionId}.json`), JSON.stringify({
    session_id: info.sessionId,
    session_secret: info.sessionSecret,
    recovery_token: info.recoveryToken,
    cli_instance_id: info.cliInstanceId,
    workspace: info.workspace || process.cwd(),
    created_at: now(),
  }, null, 2));
}

/** Write binding file — deterministic pointer for Stop Hook.
 *  Only one binding per workspace at a time (last-write-wins per MCP process). */
export function writeBindingFile(info: { sessionId: string; cliInstanceId: string; workspace: string }): void {
  const dir = resolve(info.workspace || process.cwd(), BINDING_DIR);
  mkdirSync(dir, { recursive: true });
  const bindId = `bind_${info.cliInstanceId}`;
  writeFileSync(resolve(dir, `${bindId}.json`), JSON.stringify({
    binding_id: bindId,
    session_id: info.sessionId,
    session_file: `${SESSION_DIR}/${info.sessionId}.json`,
    cli_instance_id: info.cliInstanceId,
    workspace: info.workspace || process.cwd(),
    created_at: now(),
  }, null, 2));
}
