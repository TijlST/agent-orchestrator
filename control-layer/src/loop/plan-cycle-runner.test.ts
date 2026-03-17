import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runPlanCycle } from './plan-cycle-runner.js';
import type { PlanState } from '../types/plan-state.js';
import type { TaskPacket } from '../types/task-packet.js';
import type { DispatchResult } from '../types/dispatcher.js';
import type { ReconcileResult } from '../types/reconciler.js';

const FIXED_TIME = '2026-03-16T12:00:00.000Z';

function createPacket(overrides: Partial<TaskPacket>): TaskPacket {
  const packetId = overrides.packetId ?? 'packet-1';
  const planId = overrides.planId ?? 'plan-1';

  return {
    packetId,
    planId,
    projectId: 'proj-1',
    idempotencyKey: `${packetId}-idem`,
    correlationId: `${packetId}-corr`,
    action: 'send_instruction',
    payload: {},
    dependencies: [],
    riskTier: 'read_only',
    approvalState: 'not_required',
    status: 'queued',
    attempt: 0,
    retryPolicy: {
      maxAttempts: 1,
      backoffMsBase: 1000,
      backoffMultiplier: 1,
      maxBackoffMs: 1000,
      retryOn: [],
    },
    completionCriteria: {},
    createdBy: 'test',
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    ...overrides,
  };
}

function createPlan(planId: string, packets: TaskPacket[], status: PlanState['status']): PlanState {
  return {
    planId,
    goal: 'test goal',
    projectId: 'proj-1',
    status,
    packetIds: packets.map((packet) => packet.packetId),
    openPacketIds: packets
      .filter((packet) => packet.status !== 'completed' && packet.status !== 'cancelled')
      .map((packet) => packet.packetId),
    completedPacketIds: packets
      .filter((packet) => packet.status === 'completed')
      .map((packet) => packet.packetId),
    retryBudgetRemaining: 3,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  };
}

async function writeFixture(rootDir: string, plan: PlanState, packets: TaskPacket[]): Promise<void> {
  const stateRoot = join(rootDir, 'state');
  await mkdir(join(stateRoot, 'plans'), { recursive: true });
  await mkdir(join(stateRoot, 'packets'), { recursive: true });

  await writeFile(
    join(stateRoot, 'plans', `${plan.planId}.json`),
    `${JSON.stringify(plan, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(stateRoot, 'packets', `${plan.planId}.json`),
    `${JSON.stringify(packets, null, 2)}\n`,
    'utf8',
  );
}

function createDispatchResult(
  planId: string,
  packetFilePath: string,
  overrides: Partial<DispatchResult> = {},
): DispatchResult {
  return {
    planId,
    packetFilePath,
    evaluatedCount: 0,
    dispatchedCount: 0,
    skippedCount: 0,
    dispatchedPacketIds: [],
    decisions: [],
    decisionCounts: {
      dispatched_to_session: 0,
      dry_run_marked_only: 0,
      dry_run_simulated_dispatch: 0,
      skipped_not_ready: 0,
      skipped_already_has_session: 0,
      skipped_dependency_not_satisfied: 0,
      skipped_risk_or_approval_block: 0,
      skipped_no_dispatch_capacity: 0,
    },
    packets: [],
    ...overrides,
  };
}

function createReconcileResult(
  planId: string,
  stateRoot: string,
  overrides: Partial<ReconcileResult> = {},
): ReconcileResult {
  return {
    planId,
    planFilePath: join(stateRoot, 'plans', `${planId}.json`),
    packetFilePath: join(stateRoot, 'packets', `${planId}.json`),
    evaluatedPacketCount: 0,
    completedCount: 0,
    requeuedCount: 0,
    failedCount: 0,
    unlockedCount: 0,
    planCompleted: false,
    summary: {
      completedPackets: 0,
      requeuedPackets: 0,
      failedPackets: 0,
      unlockedPackets: 0,
      planCompleted: false,
    },
    decisions: [],
    ...overrides,
  };
}

test('run-plan-cycle result includes operator summary from plan status', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'plan-cycle-summary-'));
  const stateRoot = join(rootDir, 'state');
  const planId = 'plan-cycle-summary';
  const packets = [createPacket({ packetId: 'packet-waiting', planId, status: 'waiting' })];

  await writeFixture(rootDir, createPlan(planId, packets, 'active'), packets);

  try {
    const result = await runPlanCycle(
      { planId },
      {
        stateRoot,
        dispatchRunner: async () =>
          createDispatchResult(planId, join(stateRoot, 'packets', `${planId}.json`)),
        reconcileRunner: async () => createReconcileResult(planId, stateRoot),
      },
    );

    assert.equal(result.operatorState, 'blocked_waiting');
    assert.equal(result.packetCounts.waiting, 1);
    assert.equal(result.latestStopReasons.dispatch, null);
    assert.equal(result.latestStopReasons.reconcile, null);
    assert.equal(result.latestStopReasons.plan, null);
    assert.deepEqual(result.blockingReasons, []);
    assert.equal(result.stopReason, 'blocked_waiting');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('run-plan-cycle reports blocked_governance_or_dependencies when dispatch is blocked', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'plan-cycle-blocked-governance-'));
  const stateRoot = join(rootDir, 'state');
  const planId = 'plan-cycle-blocked-governance';
  const packets = [createPacket({ packetId: 'packet-queued', planId, status: 'queued' })];

  await writeFixture(rootDir, createPlan(planId, packets, 'active'), packets);

  try {
    const result = await runPlanCycle(
      { planId },
      {
        stateRoot,
        dispatchRunner: async () =>
          createDispatchResult(planId, join(stateRoot, 'packets', `${planId}.json`), {
            evaluatedCount: 1,
            skippedCount: 1,
            decisionCounts: {
              dispatched_to_session: 0,
              dry_run_marked_only: 0,
              dry_run_simulated_dispatch: 0,
              skipped_not_ready: 0,
              skipped_already_has_session: 0,
              skipped_dependency_not_satisfied: 1,
              skipped_risk_or_approval_block: 0,
              skipped_no_dispatch_capacity: 0,
            },
          }),
        reconcileRunner: async () => createReconcileResult(planId, stateRoot),
      },
    );

    assert.equal(result.stopReason, 'blocked_governance_or_dependencies');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('run-plan-cycle reports dispatched_packets when cycle dispatches work', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'plan-cycle-dispatched-'));
  const stateRoot = join(rootDir, 'state');
  const planId = 'plan-cycle-dispatched';
  const packets = [createPacket({ packetId: 'packet-ready', planId, status: 'ready' })];

  await writeFixture(rootDir, createPlan(planId, packets, 'active'), packets);

  try {
    const result = await runPlanCycle(
      { planId },
      {
        stateRoot,
        dispatchRunner: async () =>
          createDispatchResult(planId, join(stateRoot, 'packets', `${planId}.json`), {
            dispatchedCount: 1,
          }),
        reconcileRunner: async () => createReconcileResult(planId, stateRoot),
      },
    );

    assert.equal(result.stopReason, 'dispatched_packets');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('run-plan-cycle reports reconciled_progress when reconcile advances state', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'plan-cycle-reconciled-'));
  const stateRoot = join(rootDir, 'state');
  const planId = 'plan-cycle-reconciled';
  const packets = [createPacket({ packetId: 'packet-waiting', planId, status: 'waiting' })];

  await writeFixture(rootDir, createPlan(planId, packets, 'active'), packets);

  try {
    const result = await runPlanCycle(
      { planId },
      {
        stateRoot,
        dispatchRunner: async () =>
          createDispatchResult(planId, join(stateRoot, 'packets', `${planId}.json`)),
        reconcileRunner: async () =>
          createReconcileResult(planId, stateRoot, {
            completedCount: 1,
            summary: {
              completedPackets: 1,
              requeuedPackets: 0,
              failedPackets: 0,
              unlockedPackets: 0,
              planCompleted: false,
            },
          }),
      },
    );

    assert.equal(result.stopReason, 'reconciled_progress');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('run-plan-cycle reports plan_completed for completed plans without dispatching', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'plan-cycle-completed-'));
  const stateRoot = join(rootDir, 'state');
  const planId = 'plan-cycle-completed';
  const packets = [createPacket({ packetId: 'packet-completed', planId, status: 'completed' })];

  await writeFixture(rootDir, createPlan(planId, packets, 'completed'), packets);

  try {
    const result = await runPlanCycle({ planId }, { stateRoot });

    assert.equal(result.stopReason, 'plan_completed');
    assert.equal(result.planCompleted, true);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('run-plan-cycle reports failed_terminal for terminally failed plans', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'plan-cycle-failed-terminal-'));
  const stateRoot = join(rootDir, 'state');
  const planId = 'plan-cycle-failed-terminal';
  const packets = [createPacket({ packetId: 'packet-failed', planId, status: 'failed' })];

  await writeFixture(rootDir, createPlan(planId, packets, 'failed'), packets);

  try {
    const result = await runPlanCycle({ planId }, { stateRoot });

    assert.equal(result.stopReason, 'failed_terminal');
    assert.equal(result.operatorState, 'failed_terminal');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
