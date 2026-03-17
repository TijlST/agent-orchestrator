import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPlanCycle } from './plan-cycle-runner.js';
import { loadPlanState, readTaskPackets } from '../state/file-state-store.js';
import { getPlanStatusSummary } from '../status/plan-status.js';
import type { PlanCycleRunnerResult } from '../types/plan-cycle-runner.js';
import type { TaskStatus } from '../types/task-packet.js';
import type {
  RunUntilBlockedInput,
  RunUntilBlockedResult,
} from '../types/run-until-blocked.js';
import type { RunUntilBlockedStopReason } from '../types/cycle-stop-reason.js';

const DEFAULT_MAX_CYCLES = 20;

export interface RunUntilBlockedDependencies {
  stateRoot?: string;
  cycleRunner?: (input: { planId: string }) => Promise<PlanCycleRunnerResult>;
}

function resolveControlLayerRoot(): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFilePath);
  return resolve(currentDir, '../..');
}

function countPacketsWithStatus(
  statuses: TaskStatus[],
  targetStatus: TaskStatus,
): number {
  return statuses.filter((status) => status === targetStatus).length;
}

function validateMaxCycles(maxCycles: number): void {
  if (!Number.isInteger(maxCycles) || maxCycles <= 0) {
    throw new Error('maxCycles must be a positive integer.');
  }
}

export async function runUntilBlocked(
  input: RunUntilBlockedInput,
  dependencies: RunUntilBlockedDependencies = {},
): Promise<RunUntilBlockedResult> {
  const planId = input.planId.trim();
  if (!planId) {
    throw new Error('Plan id is required.');
  }

  const maxCycles = input.maxCycles ?? DEFAULT_MAX_CYCLES;
  validateMaxCycles(maxCycles);

  const controlLayerRoot = resolveControlLayerRoot();
  const stateRoot = dependencies.stateRoot ?? resolve(controlLayerRoot, 'state');
  const planFilePath = resolve(stateRoot, 'plans', `${planId}.json`);
  const packetFilePath = resolve(stateRoot, 'packets', `${planId}.json`);

  await Promise.all([
    access(planFilePath).catch(() => {
      throw new Error(`Plan state not found for plan id "${planId}": ${planFilePath}`);
    }),
    access(packetFilePath).catch(() => {
      throw new Error(`Packet state not found for plan id "${planId}": ${packetFilePath}`);
    }),
  ]);

  const existingPlan = await loadPlanState(planFilePath);
  if (!existingPlan) {
    throw new Error(`Plan state not found for plan id "${planId}": ${planFilePath}`);
  }

  let cyclesExecuted = 0;
  let totalDispatched = 0;
  let totalCompleted = 0;
  let totalUnlocked = 0;
  let stopReason: RunUntilBlockedStopReason = 'max_iterations_reached';
  let lastCycleStopReason: RunUntilBlockedResult['lastCycleStopReason'] = null;

  if (existingPlan.status === 'completed') {
    stopReason = 'plan_completed';
  } else if (existingPlan.status === 'failed' || existingPlan.status === 'escalated') {
    stopReason = 'failed_terminal';
  } else {
    const cycleRunner = dependencies.cycleRunner ?? ((runnerInput: { planId: string }) =>
      runPlanCycle(runnerInput, { stateRoot }));

    while (cyclesExecuted < maxCycles) {
      const cycleResult = await cycleRunner({ planId });
      cyclesExecuted += 1;
      lastCycleStopReason = cycleResult.stopReason;

      totalDispatched += cycleResult.dispatchedCount;
      totalCompleted += cycleResult.completedCount;
      totalUnlocked += cycleResult.unlockedCount;

      if (cycleResult.planCompleted || cycleResult.stopReason === 'plan_completed') {
        stopReason = 'plan_completed';
        break;
      }

      if (cycleResult.stopReason === 'failed_terminal') {
        stopReason = 'failed_terminal';
        break;
      }

      if (cycleResult.stopReason === 'blocked_waiting') {
        stopReason = 'blocked_waiting';
        break;
      }

      if (cycleResult.stopReason === 'blocked_governance_or_dependencies') {
        stopReason = 'blocked_governance_or_dependencies';
        break;
      }

      if (cycleResult.stopReason === 'no_ready_packets') {
        if (cycleResult.operatorState === 'blocked_waiting' || cycleResult.remainingWaiting > 0) {
          stopReason = 'blocked_waiting';
        } else if (cycleResult.operatorState === 'blocked_governance_or_dependencies') {
          stopReason = 'blocked_governance_or_dependencies';
        } else if (cycleResult.operatorState === 'failed_terminal') {
          stopReason = 'failed_terminal';
        } else {
          stopReason = 'no_ready_packets';
        }
        break;
      }
    }
  }

  const finalPackets = await readTaskPackets(packetFilePath);
  const finalStatuses = finalPackets.map((packet) => packet.status);
  const finalPlan = await loadPlanState(planFilePath);
  const planCompleted = finalPlan?.status === 'completed';
  const statusSummary = await getPlanStatusSummary({
    planId,
    stateRoot,
  });
  if (stopReason === 'max_iterations_reached' && statusSummary.operatorState === 'failed_terminal') {
    stopReason = 'failed_terminal';
  }
  if (stopReason === 'max_iterations_reached' && statusSummary.operatorState === 'completed') {
    stopReason = 'plan_completed';
  }

  return {
    planId,
    planFilePath,
    packetFilePath,
    cyclesExecuted,
    totalDispatched,
    totalCompleted,
    totalUnlocked,
    remainingQueued: countPacketsWithStatus(finalStatuses, 'queued'),
    remainingReady: countPacketsWithStatus(finalStatuses, 'ready'),
    remainingWaiting: countPacketsWithStatus(finalStatuses, 'waiting'),
    stopReason,
    lastCycleStopReason,
    planCompleted,
    operatorState: statusSummary.operatorState,
    packetCounts: statusSummary.counts,
    latestStopReasons: statusSummary.latestStopReasons,
    blockingReasons: statusSummary.blockingReasons,
  };
}
