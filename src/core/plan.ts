import type { PlanNode, LeafStep } from '../types/index.js';
import { GateError, GateErrorCode } from './errors.js';

export function flattenPlan(nodes: PlanNode[], taskId: string, parentPath?: string): LeafStep[] {
  if (!nodes || nodes.length === 0) {
    throw new GateError(GateErrorCode.PLAN_SCHEMA_INVALID, 'Plan must have at least one step');
  }

  const now = new Date().toISOString();

  // ---- Phase 1: DFS flatten with F3b parent-dependsOn propagation ----

  interface FlatLeaf {
    stepId: string;
    nodeId: string | undefined;
    title: string;
    path: string;
    /** Node's own dependsOn: undefined=not set, []=explicitly empty */
    ownDependsOn: string[] | undefined;
    /** Dependencies inherited from ancestor containers (F3b) */
    inheritedDependsOn: string[];
  }

  const leaves: FlatLeaf[] = [];
  let idCounter = 0;

  // Maps original node ID → leaf step IDs (container IDs map to all descendants)
  const nodeToLeafStepIds = new Map<string, string[]>();

  function dfs(
    nodeList: PlanNode[],
    pathPrefix: string,
    inheritedDependsOn: string[],
  ): void {
    for (const node of nodeList) {
      if (!node.title) {
        throw new GateError(GateErrorCode.PLAN_SCHEMA_INVALID, 'Each step must have a title');
      }

      const nodePath = pathPrefix ? `${pathPrefix} / ${node.title}` : node.title;
      // Merge this node's deps into the inheritance chain for children (F3b)
      const mergedInherited = [...inheritedDependsOn, ...(node.dependsOn || [])];
      const childInherited = [...new Set(mergedInherited)];

      if (!node.children || node.children.length === 0) {
        idCounter++;
        const stepId = node.id ? `${taskId}_${node.id}` : `${taskId}_step_${idCounter}`;

        if (node.id) {
          nodeToLeafStepIds.set(node.id, [stepId]);
        }

        leaves.push({
          stepId,
          nodeId: node.id,
          title: node.title,
          path: nodePath,
          ownDependsOn: node.dependsOn,
          inheritedDependsOn,
        });
      } else {
        const beforeCount = leaves.length;
        dfs(node.children, nodePath, childInherited);

        if (node.id) {
          const descendantIds = leaves.slice(beforeCount).map(l => l.stepId);
          nodeToLeafStepIds.set(node.id, descendantIds);
        }
      }
    }
  }

  dfs(nodes, parentPath ?? '', []);

  if (leaves.length === 0) {
    throw new GateError(GateErrorCode.PLAN_SCHEMA_INVALID, 'Plan must have at least one step');
  }

  // ---- Phase 2: Resolve node IDs → leaf step IDs ----
  // Container references expand to all descendant leaf IDs.

  const resolvedDeps: string[][] = leaves.map(() => []);

  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];
    const effectiveDependsOn = [
      ...leaf.inheritedDependsOn,
      ...(leaf.ownDependsOn || []),
    ];
    const uniqueDeps = [...new Set(effectiveDependsOn)];

    const resolved: string[] = [];
    for (const depId of uniqueDeps) {
      const targetIds = nodeToLeafStepIds.get(depId);
      if (targetIds && targetIds.length > 0) {
        for (const sid of targetIds) resolved.push(sid);
      }
    }

    resolvedDeps[i] = [...new Set(resolved)];
  }

  // ---- Phase 3 (F1): Cycle detection via DFS three-color ----

  const leafIdToIndex = new Map<string, number>();
  for (let i = 0; i < leaves.length; i++) {
    leafIdToIndex.set(leaves[i].stepId, i);
  }

  enum Color { WHITE, GRAY, BLACK }
  const colors: Color[] = leaves.map(() => Color.WHITE);

  function detectCycle(idx: number, path: string[]): void {
    if (colors[idx] === Color.GRAY) {
      const cycleStart = path.indexOf(leaves[idx].stepId);
      const cyclePath = [...path.slice(cycleStart), leaves[idx].stepId].join(' → ');
      throw new GateError(
        GateErrorCode.PLAN_SCHEMA_INVALID,
        `Circular dependency detected: ${cyclePath}`,
      );
    }
    if (colors[idx] === Color.BLACK) return;

    colors[idx] = Color.GRAY;
    path.push(leaves[idx].stepId);

    for (const depId of resolvedDeps[idx]) {
      const depIdx = leafIdToIndex.get(depId);
      if (depIdx !== undefined) {
        detectCycle(depIdx, path);
      }
    }

    path.pop();
    colors[idx] = Color.BLACK;
  }

  for (let i = 0; i < leaves.length; i++) {
    if (colors[i] === Color.WHITE) {
      detectCycle(i, []);
    }
  }

  // ---- Phase 4: Build result with auto-serial fallback ----

  const result: LeafStep[] = [];

  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];
    let finalDependsOn: string[];

    const hasExplicitDeps = leaf.ownDependsOn !== undefined || leaf.inheritedDependsOn.length > 0;

    if (hasExplicitDeps) {
      finalDependsOn = resolvedDeps[i];
    } else if (i === 0) {
      finalDependsOn = [];
    } else {
      finalDependsOn = [leaves[i - 1].stepId];
    }

    result.push({
      id: leaf.stepId,
      taskId,
      parentPath: parentPath ?? null,
      title: leaf.title,
      path: leaf.path,
      orderIndex: i + 1,
      dependsOn: finalDependsOn,
      status: 'pending',
      completedAt: null,
      createdAt: now,
    });
  }

  return result;
}
