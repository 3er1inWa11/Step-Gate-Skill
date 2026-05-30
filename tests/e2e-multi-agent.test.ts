/**
 * E2E 多 Agent 协作 + 遗忘回退 — 完整数据流日志
 *
 * 模拟: Main Agent 创建计划 → 派发子 Agent → 子 Agent 遗忘前端分支
 *       → Main Agent finalize 被拦截 → 反馈给子 Agent → 回退补完
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

const DIST_INDEX = resolve(import.meta.dirname, '..', 'dist', 'index.js');

// ---- MCP Client ----
class McpClient {
  private proc: ChildProcess;
  private buf = '';
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 0;
  constructor(cmd: string, args: string[]) {
    this.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
    this.proc.stdout!.on('data', (d: Buffer) => this._feed(d));
  }
  private _feed(data: Buffer): void {
    this.buf += data.toString();
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: any;
      try { msg = JSON.parse(trimmed); } catch { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  }
  async request(method: string, params?: unknown): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method: string, params?: unknown): void {
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  async initialize(): Promise<void> {
    const caps = await this.request('initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'multi-agent', version: '1.0.0' }, capabilities: {} });
    if (!caps?.capabilities) throw new Error(`Bad init`);
    this.notify('notifications/initialized');
    await new Promise((r) => setTimeout(r, 300));
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const raw = await this.request('tools/call', { name, arguments: args });
    const merged: Record<string, unknown> = { _isError: (raw.isError as boolean) ?? false };
    if (raw.content && Array.isArray(raw.content) && raw.content.length > 0) {
      const text = raw.content[0].text;
      if (typeof text === 'string') { try { Object.assign(merged, JSON.parse(text)); } catch { merged._rawText = text; } }
    }
    return merged;
  }
  close(): void { this.proc.kill(); }
}

// ---- Plan ----
const PLAN = {
  title: '戒烟助手 App',
  steps: [
    { id: 'research', title: '用户调研', dependsOn: [] },
    { id: 'prd', title: 'PRD 文档', dependsOn: ['research'] },
    { id: 'auth', title: '认证 API', dependsOn: [] },
    { id: 'track-api', title: '吸烟追踪 API', dependsOn: ['auth'] },
    { id: 'onboarding', title: '引导页 UI', dependsOn: [] },
    { id: 'tracker-ui', title: '追踪器 UI', dependsOn: ['onboarding'] },
    { id: 'integration', title: '前后端联调', dependsOn: ['track-api', 'tracker-ui'] },
    { id: 'release', title: '发布上线', dependsOn: ['integration', 'prd'] },
  ],
};

const SEP = '─'.repeat(72);

describe('E2E: 多Agent协作 + 遗忘回退日志', () => {
  let client: McpClient;
  beforeAll(async () => { client = new McpClient('node', [DIST_INDEX]); await client.initialize(); }, 30_000);
  afterAll(() => client?.close());

  it('完整多Agent协作数据流', async () => {
    const $ = (o: any) => JSON.stringify(o, null, 2);

    type Task = { stepId: string; key: string; path: string; index: number };
    const pending: Task[] = [];

    // ================================================================
    // ACT 1: Main Agent 创建计划
    // ================================================================
    console.log(`\n${SEP}`);
    console.log('ACT 1: Main Agent — 创建计划');
    console.log(SEP);

    const start = await client.callTool('gate_start_plan', PLAN as any);
    if (start._isError || !start.currentSteps) {
      console.log('DEBUG start response:', JSON.stringify(start, null, 2));
    }
    expect(start._isError).toBe(false);
    const taskId = start.taskId as string;
    const total = (start.currentSteps as any[])[0]?.total as number;
    const initSteps = start.currentSteps as any[];
    const initKeys = start.stepKeys as Record<string, string>;

    console.log(`\n  ┌─ gate_start_plan ─────────────────────────`);
    console.log(`  │ 输入: ${$(PLAN)}`);
    console.log(`  │ 返回:`);
    console.log(`  │   taskId:     ${taskId}`);
    console.log(`  │   status:     ${start.status}`);
    console.log(`  │   totalSteps: ${total}`);
    console.log(`  │   currentSteps (初始激活):`);
    for (const s of initSteps) {
      console.log(`  │     stepId=${s.stepId}  [${s.index}/${total}] ${s.path}`);
    }
    console.log(`  │   stepKeys:`);
    for (const [id, key] of Object.entries(initKeys)) {
      console.log(`  │     ${id} → ${key}`);
    }
    console.log(`  └──────────────────────────────────────────`);

    for (const s of initSteps) {
      pending.push({ stepId: s.stepId, key: initKeys[s.stepId], path: s.path, index: s.index });
    }

    // ================================================================
    // ACT 2: Main Agent 派发子 Agent
    // ================================================================
    console.log(`\n${SEP}`);
    console.log('ACT 2: Main Agent → 派发子 Agent (并行)');
    console.log(SEP);

    // 分析三个分支
    const reqTask  = pending.find(t => t.path.includes('调研'))!;
    const authTask = pending.find(t => t.path.includes('认证'))!;
    const uiTask   = pending.find(t => t.path.includes('引导'))!;

    console.log(`
  Main Agent 将 ${total} 步计划拆为 3 个并行子任务:

  ┌─ Sub-Agent A (需求分析) ─────────────────
  │ 任务: [${reqTask.index}/${total}] ${reqTask.path}
  │ 凭证: stepId="${reqTask.stepId}"  key="${reqTask.key}"
  │ 指令: 完成后调用 gate_checkpoint({taskId, stepId, stepKey})
  └──────────────────────────────────────────

  ┌─ Sub-Agent B (后端开发) ─────────────────
  │ 任务: [${authTask.index}/${total}] ${authTask.path}
  │ 凭证: stepId="${authTask.stepId}"  key="${authTask.key}"
  │ 指令: 完成后调用 gate_checkpoint(...)
  └──────────────────────────────────────────

  ┌─ Sub-Agent C (前端开发) ─────────────────
  │ 任务: [${uiTask.index}/${total}] ${uiTask.path}
  │ 凭证: stepId="${uiTask.stepId}"  key="${uiTask.key}"
  │ 指令: 完成后调用 gate_checkpoint(...)
  └──────────────────────────────────────────`);

    // ================================================================
    // ACT 3: Sub-Agent A 完成需求分支
    // ================================================================
    console.log(`\n${SEP}`);
    console.log('ACT 3: Sub-Agent A (需求) — 执行并 checkpoint');
    console.log(SEP);

    let cp = 0;
    const checkpoint = async (step: Task, agent: string, expectedNext?: string) => {
      cp++;
      console.log(`\n  ┌─ gate_checkpoint #${cp} (${agent}) ────────`);
      console.log(`  │ 输入: { taskId, stepId: "${step.stepId}", stepKey: "${step.key}" }`);
      const r = await client.callTool('gate_checkpoint', { taskId, stepId: step.stepId, stepKey: step.key });
      console.log(`  │ 返回: accepted=${r.accepted}`);
      if (r.nextSteps) {
        const ns = r.nextSteps as any[];
        const nk = r.nextStepKeys as Record<string, string>;
        console.log(`  │       nextSteps (解锁):`);
        for (const s of ns) {
          console.log(`  │         stepId=${s.stepId}  [${s.index}/${total}] ${s.path}`);
          pending.push({ stepId: s.stepId, key: nk[s.stepId], path: s.path, index: s.index });
        }
        console.log(`  │       nextStepKeys: ${$(nk)}`);
        if (expectedNext && ns.length > 0) {
          expect(ns[0].path).toContain(expectedNext);
        }
      } else {
        console.log(`  │       nextSteps: (无 — 等待其他分支)`);
      }
      console.log(`  └──────────────────────────────────────────`);
      const idx = pending.indexOf(step);
      if (idx >= 0) pending.splice(idx, 1);
      return r;
    };

    await checkpoint(reqTask, 'Sub-Agent A', 'PRD');

    // Sub-Agent A gets PRD unlocked, completes it
    const prdTask = pending.find(t => t.path.includes('PRD'))!;
    await checkpoint(prdTask, 'Sub-Agent A');

    console.log(`\n  >>> Sub-Agent A 报告: "需求分支完成 ✓"`);

    // ================================================================
    // ACT 4: Sub-Agent B 完成后端分支
    // ================================================================
    console.log(`\n${SEP}`);
    console.log('ACT 4: Sub-Agent B (后端) — 执行并 checkpoint');
    console.log(SEP);

    await checkpoint(authTask, 'Sub-Agent B', '追踪');
    const trackApiTask = pending.find(t => t.path.includes('追踪 API'))!;
    await checkpoint(trackApiTask, 'Sub-Agent B');

    console.log(`\n  >>> Sub-Agent B 报告: "后端分支完成 ✓"`);

    // ================================================================
    // ACT 5: ⚠️ Sub-Agent C "遗忘" — 直接说做完了
    // ================================================================
    console.log(`\n${SEP}`);
    console.log('ACT 5: ⚠️ Sub-Agent C (前端) — 声称完成但未 checkpoint');
    console.log(SEP);

    console.log(`
  >>> Sub-Agent C 报告: "前端分支也做完了 ✓"

  [!] Main Agent 检查: Sub-Agent C 没有调用 gate_checkpoint!
      但 Main Agent 信任子 Agent 的能力，不信任其"完成"声明。
      所以 Main Agent 尝试 gate_finalize —— 系统会验证。`);

    // ================================================================
    // ACT 6: Main Agent 试图 Finalize → 拦截!
    // ================================================================
    console.log(`\n${SEP}`);
    console.log('ACT 6: Main Agent → gate_finalize (验证完成度)');
    console.log(SEP);

    console.log(`\n  ┌─ gate_finalize ──────────────────────────`);
    console.log(`  │ 输入: { taskId, taskKey: "FAKE01" }`);

    const f1 = await client.callTool('gate_finalize', { taskId, taskKey: 'FAKE01' });

    console.log(`  │ 返回:`);
    console.log(`  │   accepted: ${f1.accepted}`);
    console.log(`  │   _isError: ${f1._isError}`);
    console.log(`  │   status:   ${f1.status}`);
    console.log(`  │   message:  ${f1.message}`);

    const missed = f1.pendingSteps as any[];
    expect(f1.accepted).toBe(false);
    expect(missed.length).toBeGreaterThanOrEqual(3);

    console.log(`  │   pendingSteps (遗漏步骤):`);
    for (const s of missed) {
      console.log(`  │     ❌ stepId=${s.stepId}  [${s.index}/${total}] ${s.path}`);
    }
    console.log(`  └──────────────────────────────────────────`);

    // ================================================================
    // ACT 7: Main Agent 反馈给 Sub-Agent C
    // ================================================================
    console.log(`\n${SEP}`);
    console.log('ACT 7: Main Agent → Sub-Agent C 反馈');
    console.log(SEP);

    const cur = await client.callTool('gate_current', { taskId });
    const cs = cur.currentSteps as any[];

    console.log(`
  ┌─ gate_current ────────────────────────────
  │ 输入: { taskId }
  │ 返回: status=${cur.status}
  │       currentSteps:
  │         ${cs.map((s:any) => `[${s.index}/${total}] ${s.path}`).join('\n  │         ')}
  └──────────────────────────────────────────

  >>> Main Agent → Sub-Agent C:
      "你的前端分支并未完成！gate_current 显示当前步骤是:
       ${cs.map((s:any) => `${s.path} (stepId=${s.stepId})`).join('\n       ')}
       请立即调用 gate_checkpoint 完成这些步骤！
       你需要 stepKey，回看当初分配给你的凭证。"

  >>> Sub-Agent C: "抱歉，我确实漏了。现在补救。"`);

    // ================================================================
    // ACT 8: Sub-Agent C 补救
    // ================================================================
    console.log(`\n${SEP}`);
    console.log('ACT 8: Sub-Agent C — 回退补完');
    console.log(SEP);

    await checkpoint(uiTask, 'Sub-Agent C', '追踪器');

    const trackerUiTask = pending.find(t => t.path.includes('追踪器'))!;
    const r = await checkpoint(trackerUiTask, 'Sub-Agent C');

    // tracker-ui done → unlocks integration (since track-api was already done)
    const integTask = pending.find(t => t.path.includes('联调'));
    if (integTask) {
      console.log(`\n  [!] DAG 自动触发: track-api ✓ + tracker-ui ✓ → 联调已解锁!`);
    }

    // ================================================================
    // ACT 9: 联调 → 发布
    // ================================================================
    console.log(`\n${SEP}`);
    console.log('ACT 9: 联调 + 发布');
    console.log(SEP);

    if (integTask) {
      await checkpoint(integTask, 'Sub-Agent B+C (联调)');
    }

    const releaseTask = pending.find(t => t.path.includes('发布'))!;
    expect(releaseTask).toBeDefined();
    console.log(`\n  [!] DAG: integration ✓ + prd ✓ → 发布已解锁!`);

    const lastR = await checkpoint(releaseTask, 'Main Agent');
    expect(lastR.allStepsCompleted).toBe(true);
    const taskKey = lastR.taskKey as string;

    console.log(`\n  >>> 全部完成! taskKey = ${taskKey}`);

    // ================================================================
    // ACT 10: Finalize 成功 + Stop Hook
    // ================================================================
    console.log(`\n${SEP}`);
    console.log('ACT 10: Main Agent → Finalize 成功');
    console.log(SEP);

    const f2 = await client.callTool('gate_finalize', { taskId, taskKey });
    console.log(`\n  ┌─ gate_finalize (最终) ───────────────────`);
    console.log(`  │ 输入: { taskId, taskKey: "${taskKey}" }`);
    console.log(`  │ 返回: accepted=${f2.accepted}  status=${f2.status}`);
    console.log(`  │       message="${f2.message}"`);
    console.log(`  └──────────────────────────────────────────`);

    const cli = execSync('node dist/cli.js gate_active_task', { cwd: resolve(import.meta.dirname, '..') }).toString();
    const cliR = JSON.parse(cli);
    console.log(`\n  🛡️ Stop Hook → gate_active_task:`);
    console.log(`     返回: ${cli}`);
    console.log(`     结果: ${cliR.activeTasks.length === 0 ? '放行 ✓ (Agent 可安全退出)' : '拦截! (Agent 禁止退出)'}`);

    console.log(`\n${SEP}`);
    console.log('🏁 多Agent协作 + 遗忘回退 完整数据流 通过');
    console.log(SEP + '\n');
  });
});
