import type { PlanNode, LeafStep } from '../types/index.js';
import crypto from 'node:crypto';
import { GateError, GateErrorCode } from './errors.js';

export function flattenPlan(nodes: PlanNode[], taskId: string, parentPath?: string): LeafStep[] {
  if (!nodes || nodes.length === 0) {
    throw new GateError(GateErrorCode.PLAN_SCHEMA_INVALID, 'Plan must have at least one step');
  }

  const result: LeafStep[] = [];
  let idCounter = 0;
  const now = new Date().toISOString();

  function dfs(nodeList: PlanNode[], pathPrefix: string): void {
    for (const node of nodeList) {
      if (!node.title) {
        throw new GateError(GateErrorCode.PLAN_SCHEMA_INVALID, 'Each step must have a title');
      }

      const nodePath = pathPrefix ? `${pathPrefix} / ${node.title}` : node.title;

      if (!node.children || node.children.length === 0) {
        idCounter++;
        // Use explicit id if provided, otherwise auto-generate
        const stepId = node.id || `${taskId}_step_${idCounter}`;
        result.push({
          id: stepId,
          taskId,
          parentPath: parentPath ?? null,
          title: node.title,
          path: nodePath,
          orderIndex: idCounter,
          dependsOn: [], // filled in post-pass
          status: 'pending',
          completedAt: null,
          createdAt: now,
        });
      } else {
        dfs(node.children, nodePath);
      }
    }
  }

  dfs(nodes, parentPath ?? '');

  if (result.length === 0) {
    throw new GateError(GateErrorCode.PLAN_SCHEMA_INVALID, 'Plan must have at least one step');
  }

  // Second pass: resolve dependsOn for each leaf step
  // We need to map from the original node's dependsOn (which uses node ids) to leaf step ids.
  // Strategy:
  // 1. Build a set of all known ids (both explicit and auto-generated).
  // 2. For leaf nodes that come from a node with explicit dependsOn, resolve them directly.
  // 3. For leaf nodes without explicit dependsOn:
  //    - First leaf (orderIndex 1): dependsOn = []
  //    - Others: dependsOn = [previous leaf id] (auto-serial)

  // Since we lost the original node→leaf mapping during DFS, we need to carry it.
  // Re-do: track the dependsOn from the original node.
  // Actually, let's re-collect: we iterate the same nodeList and collect leaf nodes with their node-level dependsOn.

  // Simpler approach: build a map from node title/path to original dependsOn,
  // but ids are more precise. Let me re-do by collecting node metadata during DFS.

  // Actually the cleanest approach: store the original node's dependsOn alongside during DFS.
  // Let me restructure to collect node→leaf mapping.

  // Build a list of { nodeId?, nodeDependsOn? } for each leaf, in order.
  interface LeafMeta {
    leafIndex: number; // 0-based
    nodeId?: string;
    nodeDependsOn?: string[];
  }

  const leafMetas: LeafMeta[] = [];
  let metaCounter = 0;

  function dfsMeta(nodeList: PlanNode[]): void {
    for (const node of nodeList) {
      if (!node.children || node.children.length === 0) {
        leafMetas.push({
          leafIndex: metaCounter++,
          nodeId: node.id,
          nodeDependsOn: node.dependsOn,
        });
      } else {
        dfsMeta(node.children);
      }
    }
  }

  dfsMeta(nodes);

  // Now resolve dependsOn for each leaf
  for (let i = 0; i < result.length; i++) {
    const meta = leafMetas[i];
    if (meta.nodeDependsOn && meta.nodeDependsOn.length > 0) {
      // Explicit dependsOn — resolve node ids to leaf step ids
      // If a node id in dependsOn matches a leaf's nodeId, use that leaf's id
      // If it doesn't match any leaf (e.g., it's a parent node id), search by title or leave as-is
      const resolved: string[] = [];
      for (const depId of meta.nodeDependsOn) {
        // Find the leaf with matching nodeId
        const depMeta = leafMetas.find(m => m.nodeId === depId);
        if (depMeta) {
          resolved.push(result[depMeta.leafIndex].id);
        } else {
          // Could be a parent node id or unresolved — try matching by the auto-generated pattern
          // Check if depId matches any result leaf's id
          const matchByResult = result.find(r => r.id === depId);
          if (matchByResult) {
            resolved.push(depId);
          } else {
            // Fallback: keep as-is (will not resolve, but that's a user error)
            resolved.push(depId);
          }
        }
      }
      result[i].dependsOn = resolved;
    } else if (i === 0) {
      // First leaf with no explicit dependsOn → no dependencies
      result[i].dependsOn = [];
    } else {
      // Auto-serial: depends on the previous leaf
      result[i].dependsOn = [result[i - 1].id];
    }
  }

  return result;
}
