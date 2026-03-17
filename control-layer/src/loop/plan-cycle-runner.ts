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

function isGovernanceOrDependencyBlocked(dispatchResult: DispatchResult): boolean {
  if (dispatchResult.dispatchedCount > 0) {
    return false;
  }

  const { decisionCounts } = dispatchResult;
  return (
    decisionCounts.skipped_dependency_not_satisfied > 0 ||
    decisionCounts.skipped_risk_or_approval_block > 0 ||
    decisionCounts.skipped_no_dispatch_capacity > 0
  );
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

  if (plan.status === 'completed' || plan.status === 'failed' || plan.status === 'escalated') {
    const packetsAfterTerminal = await readTaskPackets(packetFilePath);
    const terminalStatuses = packetsAfterTerminal.map((packet) => packet.status);
    const statusSummary = await getPlanStatusSummary({
      planId,
      stateRoot,
    });

    return {
      planId,
      planFilePath,
      packetFilePath,
      readyBeforeDispatch: countPacketsWithStatus(terminalStatuses, 'ready'),
      dispatchedCount: 0,
      completedCount: 0,
      unlockedCount: 0,
      remainingQueued: countPacketsWithStatus(terminalStatuses, 'queued'),
      remainingReady: countPacketsWithStatus(terminalStatuses, 'ready'),
      remainingWaiting: countPacketsWithStatus(terminalStatuses, 'waiting'),
      planCompleted: plan.status === 'completed',
      stopReason: plan.status === 'completed' ? 'plan_completed' : 'failed_terminal',
      operatorState: statusSummary.operatorState,
      packetCounts: statusSummary.counts,
      latestStopReasons: statusSummary.latestStopReasons,
      blockingReasons: statusSummary.blockingReasons,
    };
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
        incomingExecutionEvents: input.incomingExecutionEvents,
      })
    : await runReconcilerStub(
        {
          planId,
          packetFile: packetFilePath,
          incomingExecutionEvents: input.incomingExecutionEvents,
        },
        { stateRoot },
      );

  const packetsAfterCycle = await readTaskPackets(packetFilePath);
  const remainingStatuses = packetsAfterCycle.map((packet) => packet.status);

  const statusSummary = await getPlanStatusSummary({
    planId,
    stateRoot,
  });
  let stopReason: CycleProgressReason = 'no_ready_packets';
  if (reconcileResult.planCompleted) {
    stopReason = 'plan_completed';
  } else if (statusSummary.operatorState === 'failed_terminal') {
    stopReason = 'failed_terminal';
  } else if (reconcileResult.completedCount > 0 || reconcileResult.unlockedCount > 0) {
    stopReason = 'reconciled_progress';
  } else if (dispatchResult.dispatchedCount > 0) {
    stopReason = 'dispatched_packets';
  } else if (statusSummary.operatorState === 'blocked_waiting') {
    stopReason = 'blocked_waiting';
  } else if (
    statusSummary.operatorState === 'blocked_governance_or_dependencies' ||
    isGovernanceOrDependencyBlocked(dispatchResult)
  ) {
    stopReason = 'blocked_governance_or_dependencies';
  }

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
    blockingReasons: statusSummary.blockingReasons,
  };
}
