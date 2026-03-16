import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { getPlanStatusSummary } from './plan-status.js';
import type { ExecutionLogEntry } from '../types/execution-log.js';
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

async function writeFixture(input: {
  rootDir: string;
  plan: PlanState;
  packets: TaskPacket[];
  logs?: ExecutionLogEntry[];
}): Promise<void> {
  const stateRoot = join(input.rootDir, 'state');
  await mkdir(join(stateRoot, 'plans'), { recursive: true });
  await mkdir(join(stateRoot, 'packets'), { recursive: true });
  await mkdir(join(stateRoot, 'logs'), { recursive: true });

  await writeFile(
    join(stateRoot, 'plans', `${input.plan.planId}.json`),
    `${JSON.stringify(input.plan, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(stateRoot, 'packets', `${input.plan.planId}.json`),
    `${JSON.stringify(input.packets, null, 2)}\n`,
    'utf8',
  );

  const logLines = (input.logs ?? []).map((entry) => JSON.stringify(entry)).join('\n');
  await writeFile(join(stateRoot, 'logs', 'execution.jsonl'), logLines ? `${logLines}\n` : '', 'utf8');
}

test('completed plan reports completed', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'plan-status-completed-'));
  const planId = 'plan-status-completed';
  const packets = [createPacket({ planId, packetId: 'packet-completed', status: 'completed' })];
  const plan = createPlan(planId, packets, 'completed');
  await writeFixture({ rootDir, plan, packets });

  try {
    const summary = await getPlanStatusSummary({
      planId,
      stateRoot: join(rootDir, 'state'),
    });
    assert.equal(summary.operatorState, 'completed');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('waiting-only plan with no ready packets reports blocked_waiting', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'plan-status-blocked-waiting-'));
  const planId = 'plan-status-blocked-waiting';
  const packets = [createPacket({ planId, packetId: 'packet-waiting', status: 'waiting' })];
  const plan = createPlan(planId, packets, 'active');
  await writeFixture({ rootDir, plan, packets });

  try {
    const summary = await getPlanStatusSummary({
      planId,
      stateRoot: join(rootDir, 'state'),
    });
    assert.equal(summary.operatorState, 'blocked_waiting');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('plan with failed packets and no progress path reports failed_terminal', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'plan-status-failed-terminal-'));
  const planId = 'plan-status-failed-terminal';
  const packets = [
    createPacket({ planId, packetId: 'packet-failed', status: 'failed' }),
    createPacket({ planId, packetId: 'packet-completed', status: 'completed' }),
  ];
  const plan = createPlan(planId, packets, 'active');
  await writeFixture({ rootDir, plan, packets });

  try {
    const summary = await getPlanStatusSummary({
      planId,
      stateRoot: join(rootDir, 'state'),
    });
    assert.equal(summary.operatorState, 'failed_terminal');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('plan with ready or dispatching activity reports progressing', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'plan-status-progressing-'));
  const planId = 'plan-status-progressing';
  const packets = [
    createPacket({ planId, packetId: 'packet-ready', status: 'ready' }),
    createPacket({ planId, packetId: 'packet-queued', status: 'queued' }),
  ];
  const plan = createPlan(planId, packets, 'active');
  await writeFixture({ rootDir, plan, packets });

  try {
    const summary = await getPlanStatusSummary({
      planId,
      stateRoot: join(rootDir, 'state'),
    });
    assert.equal(summary.operatorState, 'progressing');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('queued-only plan with no active runner reports idle_no_ready', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'plan-status-idle-no-ready-'));
  const planId = 'plan-status-idle-no-ready';
  const packets = [createPacket({ planId, packetId: 'packet-queued', status: 'queued' })];
  const plan = createPlan(planId, packets, 'active');
  await writeFixture({ rootDir, plan, packets });

  try {
    const summary = await getPlanStatusSummary({
      planId,
      stateRoot: join(rootDir, 'state'),
    });
    assert.equal(summary.operatorState, 'idle_no_ready');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('escalated plan reports failed_terminal regardless of packet statuses', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'plan-status-escalated-terminal-'));
  const planId = 'plan-status-escalated-terminal';
  const packets = [createPacket({ planId, packetId: 'packet-queued', status: 'queued' })];
  const plan = createPlan(planId, packets, 'escalated');
  await writeFixture({ rootDir, plan, packets });

  try {
    const summary = await getPlanStatusSummary({
      planId,
      stateRoot: join(rootDir, 'state'),
    });
    assert.equal(summary.operatorState, 'failed_terminal');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('summary includes packet counts and latest known reasons', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'plan-status-summary-reasons-'));
  const planId = 'plan-status-summary-reasons';
  const packets = [
    createPacket({ planId, packetId: 'packet-ready', status: 'ready' }),
    createPacket({ planId, packetId: 'packet-failed', status: 'failed' }),
    createPacket({ planId, packetId: 'packet-completed', status: 'completed' }),
  ];
  const plan = {
    ...createPlan(planId, packets, 'active'),
    blockedReason: 'waiting_for_external_input',
  };

  const logs: ExecutionLogEntry[] = [
    {
      logId: 'dispatch-1',
      timestamp: '2026-03-16T12:00:01.000Z',
      correlationId: 'corr-1',
      planId,
      packetId: 'packet-ready',
      projectId: 'proj-1',
      eventType: 'dispatch_failed',
      phase: 'dispatcher',
      actor: 'control-layer-dispatcher',
      result: 'error',
      message: 'dispatch failed',
      metadata: { reason: 'skipped_risk_or_approval_block' },
    },
    {
      logId: 'reconcile-1',
      timestamp: '2026-03-16T12:00:02.000Z',
      correlationId: 'corr-2',
      planId,
      packetId: 'packet-failed',
      projectId: 'proj-1',
      eventType: 'packet_status_changed',
      phase: 'reconciler',
      actor: 'control-layer-reconciler',
      result: 'info',
      message: 'packet moved to failed',
      beforeStatus: 'waiting',
      afterStatus: 'failed',
      metadata: { reason: 'retry_exhausted' },
    },
  ];

  await writeFixture({
    rootDir,
    plan,
    packets,
    logs,
  });

  try {
    const summary = await getPlanStatusSummary({
      planId,
      stateRoot: join(rootDir, 'state'),
    });

    assert.equal(summary.counts.totalPackets, 3);
    assert.equal(summary.counts.ready, 1);
    assert.equal(summary.counts.failed, 1);
    assert.equal(summary.counts.completed, 1);
    assert.equal(summary.latestDispatchOutcome?.eventType, 'dispatch_failed');
    assert.equal(summary.latestReconcileOutcome?.eventType, 'packet_status_changed');
    assert.equal(summary.latestStopReasons.dispatch, 'skipped_risk_or_approval_block');
    assert.equal(summary.latestStopReasons.reconcile, 'retry_exhausted');
    assert.equal(summary.latestStopReasons.plan, 'waiting_for_external_input');
    assert.equal(summary.operatorSummary.packetCounts.totalPackets, 3);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
