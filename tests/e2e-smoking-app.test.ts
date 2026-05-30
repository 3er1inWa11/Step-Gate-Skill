/**
 * E2E 全链路测试 — 戒烟 App Demo（含强制回退）
 *
 * 场景: Agent 完成了后端分支，却忘记前端分支，试图 finalize 被拦截
 *      系统列出遗漏步骤，Agent 回退补完，最终通过
 *
 * DAG 拓扑:
 *   backend ──→ db ──┐
 *   frontend ──→ ui ─┼──→ integration
 *   (两支并行, 集成需等两边都完成)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

const DIST_INDEX = resolve(import.meta.dirname, '..', 'dist', 'index.js');

// ---- MCP stdio client ----
class McpClient {
  private proc: ChildProcess;
  private buf = '';
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 0;
  private _stderr = '';

  constructor(cmd: string, args: string[]) {
    this.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
    this.proc.stdout!.on('data', (d: Buffer) => this._feed(d));
    this.proc.stderr!.on('data', (d: Buffer) => { this._stderr += d.toString(); });
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
    const caps = await this.request('initialize', {
      protocolVersion: '2025-03-26',
      clientInfo: { name: 'e2e-regression', version: '1.0.0' },
      capabilities: {},
    });
    if (!caps?.capabilities) throw new Error(`Bad init: ${JSON.stringify(caps)}`);
    this.notify('notifications/initialized');
    await new Promise((r) => setTimeout(r, 300));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const raw: any = await this.request('tools/call', { name, arguments: args });
    const merged: Record<string, unknown> = { _isError: (raw.isError as boolean) ?? false };
    if (raw.content && Array.isArray(raw.content) && raw.content.length > 0) {
      const text: string | undefined = raw.content[0].text;
      if (typeof text === 'string') {
        try { Object.assign(merged, JSON.parse(text)); } catch { merged._rawText = text; }
      }
    }
    return merged;
  }

  get stderr(): string { return this._stderr; }
  close(): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Closed')); }
    this.pending.clear();
    this.proc.kill();
  }
}

// ---- 戒烟 App DAG 并行计划 ----
// 3 个分支并行启动: 需求分析 / 后端 / 前端
//
// DAG 拓扑 (11 leaf steps):
//   需求分析 ──→ prd
//   后端 ──→ auth-api ──→ track-api ──→ reward-api ──┐
//   前端 ──→ onboarding ──→ tracker-ui ──→ dashboard ─┼──→ 测试
//   联调 ←── track-api + tracker-ui ────────────────────┘
//
const QUIT_SMOKING_DAG_PLAN = {
  title: '戒烟助手 App 完整开发计划',
  steps: [
    // 分支 1: 需求分析
    { id: 'user-research', title: '用户调研（吸烟习惯、戒烟动机）', dependsOn: [] },
    { id: 'prd', title: '产品需求文档 PRD', dependsOn: ['user-research'] },
    // 分支 2: 后端
    { id: 'auth-api', title: '用户认证与健康档案 API', dependsOn: [] },
    { id: 'track-api', title: '吸烟记录与统计分析 API', dependsOn: ['auth-api'] },
    { id: 'reward-api', title: '里程碑奖励引擎', dependsOn: ['track-api'] },
    // 分支 3: 前端
    { id: 'onboarding-ui', title: '引导页与健康问卷', dependsOn: [] },
    { id: 'tracker-ui', title: '吸烟追踪器主页', dependsOn: ['onboarding-ui'] },
    { id: 'dashboard-ui', title: '进度仪表盘（省钱+健康恢复）', dependsOn: ['tracker-ui'] },
    // 联调（需要后端 tracking + 前端 tracker 都完成）
    { id: 'integration', title: '前后端联调', dependsOn: ['track-api', 'tracker-ui'] },
    // 测试（需要联调 + 后端奖励引擎 + 前端仪表盘）
    { id: 'testing', title: '全功能测试与 App Store 发布', dependsOn: ['integration', 'reward-api', 'dashboard-ui'] },
  ],
};

// Flatten: 11 leaf steps, 初始激活 3 个 (user-research + auth-api + onboarding-ui)

describe('E2E: 强制回退 — Agent 漏步骤被拦截', () => {
  let client: McpClient;

  beforeAll(async () => {
    client = new McpClient('node', [DIST_INDEX]);
    await client.initialize();
  }, 30_000);

  afterAll(() => client?.close());

  it('完整回退流程: 10步/3分支/DAG', async () => {
    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║    戒烟 App DAG 并行 — 强制回退测试        ║');
    console.log('╚══════════════════════════════════════════════╝\n');

    type StepState = { stepId: string; key: string; path: string; index: number };

    const cp = async (s: StepState): Promise<{
      nextSteps: any[]; nextStepKeys: Record<string, string>;
      allStepsCompleted?: boolean; taskKey?: string;
    }> => {
      const r = await client.callTool('gate_checkpoint', {
        taskId, stepId: s.stepId, stepKey: s.key,
      });
      expect(r.accepted).toBe(true);
      return {
        nextSteps: (r.nextSteps || []) as any[],
        nextStepKeys: (r.nextStepKeys || {}) as Record<string, string>,
        allStepsCompleted: r.allStepsCompleted as boolean | undefined,
        taskKey: r.taskKey as string | undefined,
      };
    };

    const enqueue = (ns: any[], nk: Record<string, string>, pending: StepState[]) => {
      for (const s of ns) {
        pending.push({ stepId: s.stepId, key: nk[s.stepId], path: s.path, index: s.index });
      }
    };

    // ═══════════════════════════════════════════════════
    // 1. 创建计划
    // ═══════════════════════════════════════════════════
    const r1 = await client.callTool('gate_start_plan', QUIT_SMOKING_DAG_PLAN as any);
    expect(r1._isError).toBe(false);
    expect(r1.status).toBe('active');
    const taskId = r1.taskId as string;
    const totalSteps = (r1.currentSteps as any[])[0]?.total as number;
    expect(totalSteps).toBe(10);

    const initSteps = r1.currentSteps as any[];
    const initKeys = r1.stepKeys as Record<string, string>;
    expect(initSteps.length).toBe(3); // 3 个分支同时激活

    console.log('📋 计划已创建');
    console.log(`   taskId: ${taskId}  |  ${totalSteps} 步  |  3 并行分支\n`);

    console.log('   ⚡ DAG 拓扑:');
    console.log('   需求 ──→ prd');
    console.log('   后端 ──→ auth-api ──→ track-api ──→ reward-api ──┐');
    console.log('   前端 ──→ onboarding ──→ tracker-ui ──→ dashboard ─┼──→ 测试');
    console.log('   联调 ←── track-api + tracker-ui ──────────────────┘');
    console.log();

    // 初始步骤
    const pending: StepState[] = [];
    for (const s of initSteps) {
      pending.push({ stepId: s.stepId, key: initKeys[s.stepId], path: s.path, index: s.index });
    }

    const find = (name: string) => {
      const s = pending.find(x => x.path.includes(name));
      expect(s, `找不到步骤: ${name}`).toBeDefined();
      return s!;
    };

    console.log('   初始激活:');
    for (const s of pending) console.log(`     ├─ [${s.index}/${totalSteps}] ${s.path}`);

    // ═══════════════════════════════════════════════════
    // 2. 完成分支 1: 需求分析
    // ═══════════════════════════════════════════════════
    let cpCount = 0;
    console.log('\n── 分支 1: 需求分析 ──');
    let step = find('用户调研');
    let result = await cp(step); cpCount++;
    pending.splice(pending.indexOf(step), 1);
    enqueue(result.nextSteps, result.nextStepKeys, pending);
    console.log(`   CP#${cpCount} ✅ 用户调研 → 🔓 ${result.nextSteps[0]?.path || '(无)'}`);

    step = find('PRD');
    result = await cp(step); cpCount++;
    pending.splice(pending.indexOf(step), 1);
    enqueue(result.nextSteps, result.nextStepKeys, pending);
    console.log(`   CP#${cpCount} ✅ PRD → 需求分支完成`);

    // ═══════════════════════════════════════════════════
    // 3. 完成分支 2: 后端
    // ═══════════════════════════════════════════════════
    console.log('\n── 分支 2: 后端服务 ──');
    step = find('认证');
    result = await cp(step); cpCount++;
    pending.splice(pending.indexOf(step), 1);
    enqueue(result.nextSteps, result.nextStepKeys, pending);
    console.log(`   CP#${cpCount} ✅ 认证 API → 🔓 ${result.nextSteps[0]?.path}`);

    step = find('记录');
    result = await cp(step); cpCount++;
    pending.splice(pending.indexOf(step), 1);
    enqueue(result.nextSteps, result.nextStepKeys, pending);
    console.log(`   CP#${cpCount} ✅ 记录 API → 🔓 ${result.nextSteps[0]?.path}`);

    step = find('奖励');
    result = await cp(step); cpCount++;
    pending.splice(pending.indexOf(step), 1);
    enqueue(result.nextSteps, result.nextStepKeys, pending);
    console.log(`   CP#${cpCount} ✅ 奖励引擎 → 后端分支完成`);
    console.log('   ⏳ 联调还在等 tracker-ui...');

    // ═══════════════════════════════════════════════════
    // 4. ⚠️ Agent "忘记"了前端分支, 试图 Finalize
    // ═══════════════════════════════════════════════════
    console.log('\n═══ ⚠️  Agent 忘记前端分支, 试图 Finalize ═══');
    const f1 = await client.callTool('gate_finalize', { taskId, taskKey: 'XXXXXX' });
    expect(f1.accepted).toBe(false);
    expect(f1._isError).toBe(true);

    const missedSteps = f1.pendingSteps as any[];
    expect(missedSteps).toBeDefined();
    expect(missedSteps.length).toBe(5); // onboarding, tracker-ui, dashboard, integration, testing

    console.log(`   🚫 拦截!  遗漏 ${missedSteps.length} 步:`);
    for (const p of missedSteps) {
      console.log(`      ❌ [${p.index}/${totalSteps}] ${p.path}`);
    }

    // 确认当前活跃步骤
    const cur1 = await client.callTool('gate_current', { taskId });
    const cs = cur1.currentSteps as any[];
    console.log(`\n   当前活跃: ${cs.map((s: any) => `[${s.index}] ${s.path}`).join(', ')}`);

    // ═══════════════════════════════════════════════════
    // 5. 🔄 回退 — 补完前端分支
    // ═══════════════════════════════════════════════════
    console.log('\n═══ 🔄 回退: 补完前端分支 ═══');

    step = find('引导');
    result = await cp(step); cpCount++;
    pending.splice(pending.indexOf(step), 1);
    enqueue(result.nextSteps, result.nextStepKeys, pending);
    console.log(`   CP#${cpCount} ✅ 引导页 → 🔓 ${result.nextSteps[0]?.path}`);

    step = find('追踪器');
    result = await cp(step); cpCount++;
    pending.splice(pending.indexOf(step), 1);
    enqueue(result.nextSteps, result.nextStepKeys, pending);
    // tracker-ui 完成后, dashboard 和 integration 可能同时解锁
    console.log(`   CP#${cpCount} ✅ 追踪器 → 🔓 ${result.nextSteps.map((s:any) => s.path).join(' + ')}`);
    expect(result.nextSteps.length).toBeGreaterThanOrEqual(1);

    step = find('仪表盘');
    result = await cp(step); cpCount++;
    pending.splice(pending.indexOf(step), 1);
    enqueue(result.nextSteps, result.nextStepKeys, pending);
    console.log(`   CP#${cpCount} ✅ 仪表盘 → 前端分支完成`);

    // ═══════════════════════════════════════════════════
    // 6. 联调 + 测试
    // ═══════════════════════════════════════════════════
    console.log('\n── 🧩 联调 → 测试 → 发布 ──');

    step = find('联调');
    result = await cp(step); cpCount++;
    pending.splice(pending.indexOf(step), 1);
    enqueue(result.nextSteps, result.nextStepKeys, pending);
    console.log(`   CP#${cpCount} ✅ 联调 → 🔓 ${result.nextSteps[0]?.path || '测试'}`);

    step = find('测试');
    expect(step, '测试步骤应该已解锁').toBeDefined();
    result = await cp(step); cpCount++;
    expect(result.allStepsCompleted).toBe(true);
    const taskKey = result.taskKey as string;
    expect(taskKey).toMatch(/^[A-Z0-9]{6}$/);
    console.log(`   CP#${cpCount} ✅ 测试 → 🏁 taskKey=${taskKey}`);
    console.log(`\n   📊 共 ${cpCount} 次 checkpoint (11 步)`);

    // ═══════════════════════════════════════════════════
    // 7. Finalize
    // ═══════════════════════════════════════════════════
    console.log('\n── ✅ Finalize ──');
    const f2 = await client.callTool('gate_finalize', { taskId, taskKey });
    expect(f2.accepted).toBe(true);
    expect(f2.status).toBe('completed');
    console.log(`   ${f2.message}`);

    // ═══════════════════════════════════════════════════
    // 8. Stop Hook
    // ═══════════════════════════════════════════════════
    const cliOutput = execSync('node dist/cli.js gate_active_task', {
      cwd: resolve(import.meta.dirname, '..'),
    }).toString();
    const cliResult = JSON.parse(cliOutput);
    expect(cliResult.activeTasks.length).toBe(0);
    console.log(`\n🛡️ Stop Hook: activeTasks=0 → 放行 ✓`);

    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║  🎉 11步/3分支/DAG 强制回退 测试通过!     ║');
    console.log('╚══════════════════════════════════════════════╝');
  });
});
