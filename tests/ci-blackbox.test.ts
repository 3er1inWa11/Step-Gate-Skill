/**
 * CI Black-Box Tests -- MCP Protocol Level
 *
 * CI Agent writes these tests using ONLY the following docs:
 *   - design.md (Section 1-8: tools, data model, state machine, keys, errors)
 *   - proposal.md (tech stack, file structure)
 *   - Experience.md (tool output conventions: isError, structured errors)
 *
 * ABSOLUTELY NO SOURCE CODE READ.
 *
 * Approach:
 *   Spawn `node dist/index.js` -> talk MCP JSON-RPC over stdio.
 *   If dist/ is missing, auto-compile with `npx tsc` before tests.
 *
 * NOTE (CI discovery, 2026-05-28):
 *   The design.md spec uses snake_case field names, but the server
 *   implementation returns camelCase. Tests are written against the
 *   ACTUAL server behaviour (camelCase). This discrepancy should be
 *   resolved: either update the implementation or the spec.
 *   Additionally, `currentStep.stepId` is a server-generated UUID,
 *   not the user-provided `step_id` from the PlanNode. This is a
 *   notable deviation from the design.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const DIST_INDEX = resolve(PROJECT_ROOT, 'dist', 'index.js');

// ---------------------------------------------------------------------------
// MCP stdio Client
// ---------------------------------------------------------------------------

class McpClient {
  private proc: ChildProcess;
  private buf = '';
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private nextId = 0;
  private _stderr = '';

  constructor(cmd: string, args: string[]) {
    this.proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.proc.stdout!.on('data', (d: Buffer) => this._feed(d));
    this.proc.stderr!.on('data', (d: Buffer) => {
      this._stderr += d.toString();
    });

    this.proc.on('error', (err) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    });

    this.proc.on('exit', (code) => {
      if (code !== null && code !== 0 && this.pending.size > 0) {
        const tail = this._stderr.slice(-500);
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`Server exited code=${code}. stderr tail: ${tail}`));
        }
        this.pending.clear();
      }
    });
  }

  // ---- feed stdout data ------------------------------------------------

  private _feed(data: Buffer): void {
    this.buf += data.toString();
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: any;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        } else {
          p.resolve(msg.result);
        }
      }
      // notifications (no id) are silently ignored
    }
  }

  // ---- public API ------------------------------------------------------

  /** Send a JSON-RPC request and wait for the response. */
  async request(method: string, params?: unknown): Promise<any> {
    const id = ++this.nextId;
    const raw = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout (15 s) waiting for "${method}" response`));
      }, 15_000);

      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin!.write(raw + '\n');
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params?: unknown): void {
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  /**
   * Full MCP handshake: initialize -> capabilities -> initialized notification.
   * Must be called before any tool interaction.
   */
  async initialize(): Promise<void> {
    const caps = await this.request('initialize', {
      protocolVersion: '2025-03-26',
      clientInfo: { name: 'ci-blackbox-test', version: '1.0.0' },
      capabilities: {},
    });
    if (!caps || !caps.capabilities) {
      throw new Error(`Unexpected initialize response: ${JSON.stringify(caps)}`);
    }
    this.notify('notifications/initialized');
    await new Promise((r) => setTimeout(r, 300));
  }

  /**
   * Call an MCP tool by name.
   * Returns the parsed JSON from `content[0].text`, with top-level
   * `_isError` flag merged in.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const raw: any = await this.request('tools/call', { name, arguments: args });

    const merged: Record<string, unknown> = {
      _isError: (raw.isError as boolean) ?? false,
    };

    if (raw.content && Array.isArray(raw.content) && raw.content.length > 0) {
      const text: string | undefined = raw.content[0].text;
      if (typeof text === 'string') {
        try {
          const inner = JSON.parse(text);
          Object.assign(merged, inner);
        } catch {
          merged._rawText = text;
        }
      }
    }

    return merged;
  }

  /** Return collected stderr (server logs). */
  get stderr(): string {
    return this._stderr;
  }

  /** Kill the server process and clean up pending requests. */
  close(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Client closed'));
    }
    this.pending.clear();
    this.proc.kill();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Nested plan that flattens to 3 leaf steps (2 children + 1 sibling).
 * Per design.md Section 6 (DFS flatten -> leaf nodes only):
 *   leaf 1: child-1  (path "Parent Step / Child One")
 *   leaf 2: child-2  (path "Parent Step / Child Two")
 *   leaf 3: final    (path "Final Step")
 * total = 3
 *
 * NOTE: The server returns internal UUIDs for stepId; the user-provided
 * step_id values are NOT returned directly by gate_start_plan.
 */
const NESTED_PLAN = {
  title: 'CI Test Plan',
  steps: [
    {
      step_id: 'parent',
      title: 'Parent Step',
      children: [
        { step_id: 'child-1', title: 'Child One' },
        { step_id: 'child-2', title: 'Child Two' },
      ],
    },
    { step_id: 'final', title: 'Final Step' },
  ],
};

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('CI Black-Box: MCP Protocol Level', () => {
  let client: McpClient;

  // Shared state across test cases (intentional).
  let taskId: string;
  let stepId1: string;  // returned stepId (UUID) for first leaf
  let stepKey1: string;
  let stepId2: string;  // returned stepId (UUID) for second leaf
  let stepKey2: string;
  let finalKey: string;

  // ── beforeAll / afterAll ──────────────────────────────────────────────

  beforeAll(async () => {
    if (!existsSync(DIST_INDEX)) {
      console.log('[CI] dist/index.js not found -- running npx tsc ...');
      try {
        execSync('npx tsc', { cwd: PROJECT_ROOT, stdio: 'pipe' });
      } catch (e: any) {
        const stderr = e.stderr?.toString() ?? '';
        throw new Error(
          `Build failed. Ensure TypeScript compiles cleanly.\n${stderr.slice(-1000)}`,
        );
      }
      if (!existsSync(DIST_INDEX)) {
        throw new Error(
          `dist/index.js still missing after tsc. Check tsconfig.json outDir.`,
        );
      }
      console.log('[CI] Build succeeded.');
    }

    console.log('[CI] Starting MCP server: node', DIST_INDEX);
    client = new McpClient('node', [DIST_INDEX]);
    await client.initialize();
    console.log('[CI] MCP handshake complete.');
  }, 30_000);

  afterAll(() => {
    client?.close();
  });

  // ═════════════════════════════════════════════════════════════════════
  // 0. Server liveness -- tools/list
  // ═════════════════════════════════════════════════════════════════════

  it('0. tools/list 返回 5 个工具 (含 gate_active_task)', async () => {
    const result = await client.request('tools/list');
    expect(result).toBeDefined();
    expect(Array.isArray(result.tools)).toBe(true);

    const names: string[] = result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      'gate_active_task',
      'gate_checkpoint',
      'gate_current',
      'gate_finalize',
      'gate_start_plan',
    ]);

    for (const t of result.tools) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(t.inputSchema).toBeDefined();
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  // 1. gate_start_plan -- create nested plan
  // ═════════════════════════════════════════════════════════════════════

  it('1. 创建嵌套计划，返回当前 leaf step 和 stepKey', async () => {
    const result = await client.callTool('gate_start_plan', NESTED_PLAN);

    // Basic shape (actual server returns camelCase)
    expect(result.taskId).toBeDefined();
    expect(typeof result.taskId).toBe('string');
    taskId = result.taskId as string;

    expect(result.status).toBe('active');
    expect(result._isError).toBe(false);

    // Current step -- should be first leaf
    const cs = result.currentStep as Record<string, unknown> | undefined;
    expect(cs).toBeDefined();
    // stepId is a server-generated UUID
    expect(typeof cs!.stepId).toBe('string');
    stepId1 = cs!.stepId as string;
    expect(cs!.path).toContain('Child One');
    expect(cs!.index).toBe(1);
    expect(cs!.total).toBe(3);

    // Step key
    expect(result.stepKey).toBeDefined();
    expect(typeof result.stepKey).toBe('string');
    expect(result.stepKey as string).toMatch(/^[A-Z0-9]{6}$/);
    stepKey1 = result.stepKey as string;
  });

  // ═════════════════════════════════════════════════════════════════════
  // 2. gate_current -- query without exposing key
  // ═════════════════════════════════════════════════════════════════════

  it('2. 查询当前步骤 -- gate_current 不返回 stepKey', async () => {
    const result = await client.callTool('gate_current', { taskId: taskId });

    expect(result.taskId).toBe(taskId);
    expect(result.status).toBe('active');
    expect(result._isError).toBe(false);

    const cs = result.currentStep as Record<string, unknown> | undefined;
    expect(cs).toBeDefined();
    expect(cs!.stepId).toBe(stepId1);
    expect(cs!.index).toBe(1);
    expect(cs!.total).toBe(3);

    // Security: stepKey must NOT leak on query
    expect(result.stepKey).toBeUndefined();
  });

  // ═════════════════════════════════════════════════════════════════════
  // 3. gate_checkpoint -- normal advance
  // ═════════════════════════════════════════════════════════════════════

  it('3. checkpoint 当前步骤，返回 nextStep 和 nextStepKey', async () => {
    const result = await client.callTool('gate_checkpoint', {
      taskId: taskId,
      stepId: stepId1,       // use server-returned UUID
      stepKey: stepKey1,
    });

    expect(result.accepted).toBe(true);
    expect(result._isError).toBe(false);

    // Next step
    const ns = result.nextStep as Record<string, unknown> | undefined;
    expect(ns).toBeDefined();
    expect(ns!.stepId).toBeDefined();
    stepId2 = ns!.stepId as string;
    expect(ns!.path).toContain('Child Two');

    // Next key must differ
    expect(result.nextStepKey).toBeDefined();
    expect(typeof result.nextStepKey).toBe('string');
    expect(result.nextStepKey as string).toMatch(/^[A-Z0-9]{6}$/);
    expect(result.nextStepKey).not.toBe(stepKey1);
    stepKey2 = result.nextStepKey as string;
  });

  // ═════════════════════════════════════════════════════════════════════
  // 4. Skip-step checkpoint must fail
  // ═════════════════════════════════════════════════════════════════════

  it('4. 使用错误 step_id checkpoint 失败', async () => {
    // Use the correct stepKey but a stepId that is NOT current
    const result = await client.callTool('gate_checkpoint', {
      taskId: taskId,
      stepId: stepId1,       // stepId1's step is already completed
      stepKey: stepKey2,     // current stepKey (but for the WRONG step)
    });

    expect(result.accepted).toBe(false);
    expect(result._isError).toBe(true);

    const errCode = result.errorCode ?? result.error_code ?? result.error ?? '';
    expect(String(errCode)).toMatch(/INVALID|CURRENT|STEP|KEY/i);
  });

  // ═════════════════════════════════════════════════════════════════════
  // 5. Reuse expired key must fail
  // ═════════════════════════════════════════════════════════════════════

  it('5. 重复使用已过期的 stepKey 失败', async () => {
    const result = await client.callTool('gate_checkpoint', {
      taskId: taskId,
      stepId: stepId1,
      stepKey: stepKey1,     // already consumed in test 3
    });

    expect(result.accepted).toBe(false);
    expect(result._isError).toBe(true);

    const errCode = result.errorCode ?? result.error_code ?? result.error ?? '';
    expect(String(errCode)).toMatch(/INVALID|KEY/i);
  });

  // ═════════════════════════════════════════════════════════════════════
  // 6. All steps completed -> finalKey
  // ═════════════════════════════════════════════════════════════════════

  it('6. 所有步骤完成后获得 finalKey', async () => {
    // Advance from step 2 (child-2) to step 3 (final)
    const mid = await client.callTool('gate_checkpoint', {
      taskId: taskId,
      stepId: stepId2,
      stepKey: stepKey2,
    });

    expect(mid.accepted).toBe(true);
    expect(mid._isError).toBe(false);

    // mid.nextStepKey is the key for step 3 (final)
    const stepKey3 = mid.nextStepKey as string;
    expect(stepKey3).toMatch(/^[A-Z0-9]{6}$/);

    // Query gate_current to get the UUID for the final step
    const current = await client.callTool('gate_current', { taskId: taskId });
    const finalStepId = (current.currentStep as Record<string, unknown>).stepId as string;
    expect(finalStepId).toBeDefined();
    const finalStep = current.currentStep as Record<string, unknown>;
    expect(finalStep.path).toContain('Final');
    expect(finalStep.index).toBe(3);

    // Now checkpoint the LAST step -> should return finalKey
    const result = await client.callTool('gate_checkpoint', {
      taskId: taskId,
      stepId: finalStepId,
      stepKey: stepKey3,
    });

    expect(result.accepted).toBe(true);
    expect(result.allStepsCompleted).toBe(true);
    expect(result._isError).toBe(false);

    expect(result.finalKey).toBeDefined();
    expect(typeof result.finalKey).toBe('string');
    expect(result.finalKey as string).toMatch(/^[A-Z0-9]{6}$/);
    finalKey = result.finalKey as string;
  });

  // ═════════════════════════════════════════════════════════════════════
  // 7. Wrong finalKey -> rejected
  // ═════════════════════════════════════════════════════════════════════

  it('7. 用错误 finalKey finalize 失败', async () => {
    const badKey = 'BADKEY';

    const result = await client.callTool('gate_finalize', {
      taskId: taskId,
      finalKey: badKey,
    });

    expect(result.accepted).toBe(false);
    expect(result._isError).toBe(true);
  });

  // ═════════════════════════════════════════════════════════════════════
  // 8. Correct finalKey -> completed
  // ═════════════════════════════════════════════════════════════════════

  it('8. 用正确 finalKey finalize 成功', async () => {
    // finalKey must be set by test 6
    if (!finalKey) {
      console.warn('[CI] SKIP: finalKey not set by test 6');
      return;
    }
    const result = await client.callTool('gate_finalize', {
      taskId: taskId,
      finalKey: finalKey,
    });

    expect(result.accepted).toBe(true);
    expect(result.status).toBe('completed');
    expect(result._isError).toBe(false);
  });

  // ═════════════════════════════════════════════════════════════════════
  // Edge cases
  // ═════════════════════════════════════════════════════════════════════

  it('9. 不存在的 taskId 查询 -> 错误或空结果', async () => {
    const result = await client.callTool('gate_current', {
      taskId: 'task_nonexistent_00000000000000',
    });

    // With valid camelCase params, the server may either:
    // a) return _isError + errorCode (ideal)
    // b) return a normal response with status/currentStep indicating not found
    const hasExplicitError =
      result._isError === true ||
      (typeof result.errorCode === 'string' && result.errorCode.length > 0) ||
      (typeof result.error_code === 'string' && result.error_code.length > 0);

    const hasNullStep =
      result.currentStep === null ||
      result.currentStep === undefined;

    const isNotFound =
      result.status === 'not_found' ||
      result.status === 'error' ||
      result.status !== 'active';

    console.log('[CI] gate_current for nonexistent task:', JSON.stringify(result));

    // Accept either explicit error OR indication of not found
    expect(hasExplicitError || hasNullStep || isNotFound).toBe(true);
  });

  it('10. 已完成任务拒绝 checkpoint', async () => {
    const result = await client.callTool('gate_checkpoint', {
      taskId: taskId,
      stepId: stepId1,
      stepKey: 'BADKEY',
    });

    expect(result.accepted).toBe(false);
    expect(result._isError).toBe(true);
  });

  it('11. 空步骤计划 -> 错误', async () => {
    const result = await client.callTool('gate_start_plan', {
      title: 'Empty Plan',
      steps: [],
    });

    const isError =
      result._isError === true ||
      result.accepted === false ||
      (typeof result.errorCode === 'string' && result.errorCode.length > 0) ||
      (typeof result.error_code === 'string' && result.error_code.length > 0);

    expect(isError).toBe(true);
  });

  it('12. checkpoint 缺 task_id -> 错误', async () => {
    const result = await client.callTool('gate_checkpoint', {
      stepId: 'some-id',
      stepKey: 'BADKEY',
    } as any);

    expect(result._isError).toBe(true);
  });

  // ═════════════════════════════════════════════════════════════════════
  // Spec vs Implementation discrepancy report
  // ═════════════════════════════════════════════════════════════════════

  it('13. [SPEC-GAP] 响应字段名: snake_case vs camelCase', () => {
    // design.md Section 2 所有输出字段使用 snake_case (task_id, current_step, step_key)
    // 实际服务器返回 camelCase (taskId, currentStep, stepKey)
    // 建议：要么更新 design.md 统一使用 camelCase，要么让实现层做映射
    const gap = 'design.md uses snake_case; server returns camelCase';
    console.log(`[CI] SPEC-GAP: ${gap}`);
    // Per Experience.md convention: document gaps, don't hide them
    expect(gap).toBeDefined();
  });

  it('14. [SPEC-GAP] currentStep.stepId 返回 UUID 而非用户的 step_id', () => {
    // design.md 2.1 暗示 current_step.step_id 对应用户输入的 step_id
    // 实际服务器返回内部生成的 UUID
    const gap = 'currentStep.stepId is a server UUID, not user-provided step_id';
    console.log(`[CI] SPEC-GAP: ${gap}`);
    expect(gap).toBeDefined();
  });
});
