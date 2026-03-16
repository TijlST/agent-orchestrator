import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDispatcher } from '../dispatcher/run-dispatcher.js';
import { runReconcilerStub } from '../reconciler/reconciler-stub.js';
import { loadPlanState, readTaskPackets } from '../state/file-state-store.js';
import { getPlanStatusSummary } from '../status/plan-status.js';
import type { DispatchResult, DispatcherInput } from '../types/dispatcher.js';
import type { ReconcileResult, ReconcilerInput } from '../types/reconciler.js';
import type { TaskStatus } from '../types/task-packet.js';
import type {
  PlanCycleRunnerInput,
  PlanCycleRunnerResult,
} from '../types/plan-cycle-runner.js';
import type { CycleProgressReason } from '../types/cycle-stop-reason.js';

export interface PlanCycleRunnerDependencies {
  stateRoot?: string;
  dispatchRunner?: (input: DispatcherInput) => Promise<DispatchResult>;
  reconcileRunner?: (input: ReconcilerInput) => Promise<ReconcileResult>;
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

export async function runPlanCycle(
  input: PlanCycleRunnerInput,
  dependencies: PlanCycleRunnerDependencies = {},
): Promise<PlanCycleRunnerResult> {
  const planId = input.planId.trim();
  if (!planId) {
    throw new Error('Plan id is required.');
  }

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

  const plan = await loadPlanState(planFilePath);
  if (!plan) {
    throw new Error(`Plan state not found for plan id "${planId}": ${planFilePath}`);
  }

  const packetsBeforeDispatch = await readTaskPackets(packetFilePath);
  const readyBeforeDispatch = countPacketsWithStatus(
    packetsBeforeDispatch.map((packet) => packet.status),
    'ready',
  );

  const dispatchRunner = dependencies.dispatchRunner ?? runDispatcher;

  const dispatchResult = await dispatchRunner({
    planId,
    packetFile: packetFilePath,
  });

  const reconcileResult = dependencies.reconcileRunner
    ? await dependencies.reconcileRunner({
        planId,
        packetFile: packetFilePath,
      })
    : await runReconcilerStub(
        {
          planId,
          packetFile: packetFilePath,
        },
        { stateRoot },
      );

  const packetsAfterCycle = await readTaskPackets(packetFilePath);
  const remainingStatuses = packetsAfterCycle.map((packet) => packet.status);

  let stopReason: CycleProgressReason = 'no_ready_packets';
  if (reconcileResult.planCompleted) {
    stopReason = 'plan_completed';
  } else if (reconcileResult.completedCount > 0 || reconcileResult.unlockedCount > 0) {
    stopReason = 'reconciled_progress';
  } else if (dispatchResult.dispatchedCount > 0) {
    stopReason = 'dispatched_packets';
  }

  const statusSummary = await getPlanStatusSummary({
    planId,
    stateRoot,
  });

  return {
    planId,
    planFilePath,
    packetFilePath,
    readyBeforeDispatch,
    dispatchedCount: dispatchResult.dispatchedCount,
    completedCount: reconcileResult.completedCount,
    unlockedCount: reconcileResult.unlockedCount,
    remainingQueued: countPacketsWithStatus(remainingStatuses, 'queued'),
    remainingReady: countPacketsWithStatus(remainingStatuses, 'ready'),
    remainingWaiting: countPacketsWithStatus(remainingStatuses, 'waiting'),
    planCompleted: reconcileResult.planCompleted,
    stopReason,
    operatorState: statusSummary.operatorState,
    packetCounts: statusSummary.counts,
    latestStopReasons: statusSummary.latestStopReasons,
  };
}
