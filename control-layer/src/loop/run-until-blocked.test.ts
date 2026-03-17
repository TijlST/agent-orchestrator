import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runUntilBlocked } from './run-until-blocked.js';
import type { PlanCycleRunnerResult } from '../types/plan-cycle-runner.js';
import type { PlanState } from '../types/plan-state.js';
import type { TaskPacket } from '../types/task-packet.js';

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

  await writeFile(join(stateRoot, 'plans', `${plan.planId}.json`), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  await writeFile(join(stateRoot, 'packets', `${plan.planId}.json`), `${JSON.stringify(packets, null, 2)}\n`, 'utf8');
}

function createCycleResult(overrides: Partial<PlanCycleRunnerResult>): PlanCycleRunnerResult {
  const planId = overrides.planId ?? 'plan-1';
  return {
    planId,
    planFilePath: overrides.planFilePath ?? '/tmp/unused-plan.json',
    packetFilePath: overrides.packetFilePath ?? '/tmp/unused-packets.json',
    readyBeforeDispatch: overrides.readyBeforeDispatch ?? 0,
    dispatchedCount: overrides.dispatchedCount ?? 0,
    completedCount: overrides.completedCount ?? 0,
    unlockedCount: overrides.unlockedCount ?? 0,
    remainingQueued: overrides.remainingQueued ?? 0,
    remainingReady: overrides.remainingReady ?? 0,
    remainingWaiting: overrides.remainingWaiting ?? 0,
    planCompleted: overrides.planCompleted ?? false,
    stopReason: overrides.stopReason ?? 'no_ready_packets',
    operatorState: overrides.operatorState ?? 'idle_no_ready',
    packetCounts: overrides.packetCounts ?? {
      totalPackets: 0,
      queued: 0,
      ready: 0,
      dispatching: 0,
      waiting: 0,
      retry: 0,
      blocked: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    },
    latestStopReasons: overrides.latestStopReasons ?? {
      dispatch: null,
      reconcile: null,
      plan: null,
    },
    blockingReasons: overrides.blockingReasons ?? [],
  };
}

test('run-until-blocked stops with blocked_waiting when no further progress is possible', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'until-blocked-waiting-'));
  const stateRoot = join(rootDir, 'state');
  const planId = 'plan-blocked-waiting';
  const packets = [createPacket({ packetId: 'packet-waiting', planId, status: 'waiting' })];

  await writeFixture(rootDir, createPlan(planId, packets, 'active'), packets);

  try {
    const result = await runUntilBlocked(
      { planId, maxCycles: 3 },
      {
        stateRoot,
        cycleRunner: async () =>
          createCycleResult({
            planId,
            stopReason: 'no_ready_packets',
            remainingWaiting: 1,
            remainingReady: 0,
            remainingQueued: 0,
          }),
      },
    );

    assert.equal(result.stopReason, 'blocked_waiting');
    assert.equal(result.cyclesExecuted, 1);
    assert.equal(result.operatorState, 'blocked_waiting');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('run-until-blocked stops with blocked_governance_or_dependencies when dispatch is blocked', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'until-blocked-governance-'));
  const stateRoot = join(rootDir, 'state');
  const planId = 'plan-blocked-governance';
  const packets = [createPacket({ packetId: 'packet-queued', planId, status: 'queued' })];

  await writeFixture(rootDir, createPlan(planId, packets, 'active'), packets);

  try {
    const result = await runUntilBlocked(
      { planId, maxCycles: 3 },
      {
        stateRoot,
        cycleRunner: async () =>
          createCycleResult({
            planId,
            stopReason: 'blocked_governance_or_dependencies',
            remainingWaiting: 0,
            remainingReady: 0,
            remainingQueued: 1,
            operatorState: 'blocked_governance_or_dependencies',
            latestStopReasons: {
              dispatch: 'skipped_dependency_not_satisfied',
              reconcile: null,
              plan: null,
            },
            blockingReasons: ['skipped_dependency_not_satisfied'],
          }),
      },
    );

    assert.equal(result.stopReason, 'blocked_governance_or_dependencies');
    assert.equal(result.cyclesExecuted, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('run-until-blocked stops with plan_completed when plan completes', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'until-blocked-completed-'));
  const stateRoot = join(rootDir, 'state');
  const planId = 'plan-completed';
  const packets = [createPacket({ packetId: 'packet-complete', planId, status: 'waiting' })];

  await writeFixture(rootDir, createPlan(planId, packets, 'active'), packets);

  try {
    const result = await runUntilBlocked(
      { planId, maxCycles: 5 },
      {
        stateRoot,
        cycleRunner: async () => {
          const completedPackets: TaskPacket[] = [
            createPacket({
              ...packets[0],
              status: 'completed',
              completedAt: FIXED_TIME,
            }),
          ];
          const completedPlan = createPlan(planId, completedPackets, 'completed');
          await writeFixture(rootDir, completedPlan, completedPackets);

          return createCycleResult({
            planId,
            stopReason: 'plan_completed',
            planCompleted: true,
            completedCount: 1,
          });
        },
      },
    );

    assert.equal(result.stopReason, 'plan_completed');
    assert.equal(result.planCompleted, true);
    assert.equal(result.cyclesExecuted, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('run-until-blocked stops with max_iterations_reached when capped', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'until-blocked-max-'));
  const stateRoot = join(rootDir, 'state');
  const planId = 'plan-max-iterations';
  const packets = [createPacket({ packetId: 'packet-ready', planId, status: 'ready' })];

  await writeFixture(rootDir, createPlan(planId, packets, 'active'), packets);

  let cycleCount = 0;

  try {
    const result = await runUntilBlocked(
      { planId, maxCycles: 2 },
      {
        stateRoot,
        cycleRunner: async () => {
          cycleCount += 1;
          return createCycleResult({
            planId,
            stopReason: 'dispatched_packets',
            dispatchedCount: 1,
            remainingReady: 1,
          });
        },
      },
    );

    assert.equal(cycleCount, 2);
    assert.equal(result.stopReason, 'max_iterations_reached');
    assert.equal(result.lastCycleStopReason, 'dispatched_packets');
    assert.equal(result.cyclesExecuted, 2);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('run-until-blocked returns failed_terminal for terminal plans before cycle execution', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'until-blocked-failed-terminal-'));
  const stateRoot = join(rootDir, 'state');
  const planId = 'plan-failed-terminal';
  const packets = [createPacket({ packetId: 'packet-failed', planId, status: 'failed' })];

  await writeFixture(rootDir, createPlan(planId, packets, 'failed'), packets);

  try {
    const result = await runUntilBlocked({ planId, maxCycles: 2 }, { stateRoot });

    assert.equal(result.stopReason, 'failed_terminal');
    assert.equal(result.cyclesExecuted, 0);
    assert.equal(result.operatorState, 'failed_terminal');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
