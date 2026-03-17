import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDispatcher } from '../dispatcher/run-dispatcher.js';
import { appendExecutionLogEntry } from '../logging/file-execution-log.js';
import { createDeterministicPlan } from '../planner/deterministic-planner.js';
import { runReconcilerStub } from '../reconciler/reconciler-stub.js';
import {
  ensureDirectoryExists,
  savePlanState,
  writeTaskPackets,
} from '../state/file-state-store.js';
import { getPlanStatusSummary } from '../status/plan-status.js';
import type { DispatchResult, DispatcherInput } from '../types/dispatcher.js';
import type { ExecutionLogEntry } from '../types/execution-log.js';
import type { PlannerOutput } from '../types/planner.js';
import type { ReconcileResult, ReconcilerInput } from '../types/reconciler.js';
import type {
  SingleCycleRunnerInput,
  SingleCycleRunnerResult,
} from '../types/loop-runner.js';
import type { CycleProgressReason } from '../types/cycle-stop-reason.js';

const DEFAULT_PROJECT_ID = 'agent-orchestrator';
const DEFAULT_PLANNER_ACTOR = 'control-layer-planner';

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

export interface SingleCycleRunnerDependencies {
  stateRoot?: string;
  now?: () => string;
  planner?: (goal: string) => PlannerOutput;
  dispatchRunner?: (input: DispatcherInput) => Promise<DispatchResult>;
  reconcileRunner?: (input: ReconcilerInput) => Promise<ReconcileResult>;
}

function resolveControlLayerRoot(): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFilePath);
  return resolve(currentDir, '../..');
}

function createPlanCreatedLogEntry(
  planId: string,
  projectId: string,
  correlationId: string,
  timestamp: string,
): ExecutionLogEntry {
  return {
    logId: `${planId}_log_plan_created`,
    timestamp,
    correlationId,
    planId,
    projectId,
    eventType: 'plan_created',
    phase: 'planner',
    actor: DEFAULT_PLANNER_ACTOR,
    result: 'success',
    message: 'Created deterministic plan from CLI goal input.',
  };
}

function createPacketCreatedLogEntry(
  planId: string,
  projectId: string,
  packetId: string,
  correlationId: string,
  timestamp: string,
): ExecutionLogEntry {
  return {
    logId: `${planId}_log_packet_created_1`,
    timestamp,
    correlationId,
    planId,
    packetId,
    projectId,
    eventType: 'packet_created',
    phase: 'planner',
    actor: DEFAULT_PLANNER_ACTOR,
    result: 'success',
    message: 'Created initial deterministic task packet.',
  };
}

export async function runSingleCycle(
  input: SingleCycleRunnerInput,
  dependencies: SingleCycleRunnerDependencies = {},
): Promise<SingleCycleRunnerResult> {
  const goal = input.goal.trim();
  if (!goal) {
    throw new Error('Goal is required.');
  }

  const controlLayerRoot = resolveControlLayerRoot();
  const stateRoot = dependencies.stateRoot ?? resolve(controlLayerRoot, 'state');
  const plansDir = resolve(stateRoot, 'plans');
  const packetsDir = resolve(stateRoot, 'packets');
  const logsDir = resolve(stateRoot, 'logs');
  const logFilePath = resolve(logsDir, 'execution.jsonl');

  await Promise.all([
    ensureDirectoryExists(stateRoot),
    ensureDirectoryExists(plansDir),
    ensureDirectoryExists(packetsDir),
    ensureDirectoryExists(logsDir),
  ]);

  const timestamp = dependencies.now ? dependencies.now() : new Date().toISOString();
  const planner = dependencies.planner ?? ((goalInput: string) => createDeterministicPlan(goalInput, {
    projectId: DEFAULT_PROJECT_ID,
    actor: DEFAULT_PLANNER_ACTOR,
    timestamp,
  }));
  const plannerOutput = planner(goal);

  const { planState, packets } = plannerOutput;
  const planFilePath = resolve(plansDir, `${planState.planId}.json`);
  const packetFilePath = resolve(packetsDir, `${planState.planId}.json`);

  await savePlanState(planFilePath, planState);
  await writeTaskPackets(packetFilePath, packets);

  const firstPacket = packets[0];
  const baseCorrelationId = `${planState.planId}_corr_plan`;

  await appendExecutionLogEntry(
    logFilePath,
    createPlanCreatedLogEntry(
      planState.planId,
      planState.projectId,
      baseCorrelationId,
      timestamp,
    ),
  );

  if (firstPacket) {
    await appendExecutionLogEntry(
      logFilePath,
      createPacketCreatedLogEntry(
        planState.planId,
        planState.projectId,
        firstPacket.packetId,
        firstPacket.correlationId,
        timestamp,
      ),
    );
  }

  const dispatchRunner = dependencies.dispatchRunner ?? runDispatcher;

  const dispatchResult = await dispatchRunner({
    planId: planState.planId,
    packetFile: packetFilePath,
  });

  const reconcileResult = dependencies.reconcileRunner
    ? await dependencies.reconcileRunner({
        planId: planState.planId,
        packetFile: packetFilePath,
        incomingExecutionEvents: input.incomingExecutionEvents,
      })
    : await runReconcilerStub(
        {
          planId: planState.planId,
          packetFile: packetFilePath,
          incomingExecutionEvents: input.incomingExecutionEvents,
        },
        { stateRoot },
      );

  const statusSummary = await getPlanStatusSummary({
    planId: planState.planId,
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
    planId: planState.planId,
    planFilePath: reconcileResult.planFilePath,
    packetFilePath: dispatchResult.packetFilePath,
    dispatchedCount: dispatchResult.dispatchedCount,
    completedCount: reconcileResult.completedCount,
    unlockedCount: reconcileResult.unlockedCount,
    planCompleted: reconcileResult.planCompleted,
    stopReason,
    operatorState: statusSummary.operatorState,
    packetCounts: statusSummary.counts,
    latestStopReasons: statusSummary.latestStopReasons,
    blockingReasons: statusSummary.blockingReasons,
  };
}
