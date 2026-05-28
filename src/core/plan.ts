import type { PlanNode, LeafStep } from '../types/index.js';
import crypto from 'node:crypto';
import { GateError, GateErrorCode } from './errors.js';

export function flattenPlan(nodes: PlanNode[], taskId: string, parentPath?: string): LeafStep[] {
  if (!nodes || nodes.length === 0) {
    throw new GateError(GateErrorCode.PLAN_SCHEMA_INVALID, 'Plan must have at least one step');
  }

  const result: LeafStep[] = [];
  let orderCounter = 0;
  const now = new Date().toISOString();

  function dfs(nodeList: PlanNode[], pathPrefix: string): void {
    for (const node of nodeList) {
      if (!node.title) {
        throw new GateError(GateErrorCode.PLAN_SCHEMA_INVALID, 'Each step must have a title');
      }

      const nodePath = pathPrefix ? `${pathPrefix} / ${node.title}` : node.title;

      if (!node.children || node.children.length === 0) {
        orderCounter++;
        result.push({
          id: crypto.randomUUID(),
          taskId,
          parentPath: parentPath ?? null,
          title: node.title,
          path: nodePath,
          orderIndex: orderCounter,
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

  return result;
}
