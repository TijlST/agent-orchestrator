import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runPlanCycle } from './plan-cycle-runner.js';
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
        dispatchRunner: async () => ({
          planId,
          packetFilePath: join(stateRoot, 'packets', `${planId}.json`),
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
        }),
        reconcileRunner: async () => ({
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
        }),
      },
    );

    assert.equal(result.operatorState, 'blocked_waiting');
    assert.equal(result.packetCounts.waiting, 1);
    assert.equal(result.latestStopReasons.dispatch, null);
    assert.equal(result.latestStopReasons.reconcile, null);
    assert.equal(result.latestStopReasons.plan, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
