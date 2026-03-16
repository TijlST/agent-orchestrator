import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { runDispatcherAoDryRun } from './dispatcher-ao-dry-run.js';
import { runDispatcherAoExec } from './dispatcher-ao-exec.js';
import type { Session } from '../../../packages/core/dist/index.js';
import type { TaskPacket } from '../types/task-packet.js';
import type { DispatchDecisionReason } from '../types/dispatcher.js';

const FIXED_TIME = '2026-03-16T12:00:00.000Z';

function createPacket(overrides: Partial<TaskPacket>): TaskPacket {
  const packetId = overrides.packetId ?? 'packet-1';
  const planId = overrides.planId ?? 'plan-1';

  return {
    packetId,
    planId,
    projectId: 'project-1',
    idempotencyKey: `${packetId}-idem`,
    correlationId: `${packetId}-corr`,
    action: 'send_instruction',
    payload: {
      instruction: 'echo "dry-run"',
    },
    dependencies: [],
    riskTier: 'read_only',
    approvalState: 'not_required',
    status: 'ready',
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

function resolveDispatchFilePath(planId: string): string {
  return resolve(process.cwd(), 'state', 'dispatches', `${planId}.json`);
}

async function runWithPackets(planId: string, packets: TaskPacket[], maxDispatches?: number) {
  const rootDir = await mkdtemp(join(tmpdir(), 'dispatcher-dry-run-'));
  const packetFilePath = join(rootDir, `${planId}.json`);
  const dispatchFilePath = resolveDispatchFilePath(planId);

  await writeFile(packetFilePath, `${JSON.stringify(packets, null, 2)}\n`, 'utf8');

  try {
    const result = await runDispatcherAoDryRun({
      planId,
      packetFile: packetFilePath,
      maxDispatches,
      timestamp: FIXED_TIME,
    });
    const persistedPackets = JSON.parse(await readFile(packetFilePath, 'utf8')) as TaskPacket[];

    return { result, persistedPackets };
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await unlink(dispatchFilePath).catch(() => {});
  }
}

function createSession(sessionId: string): Session {
  return {
    id: sessionId,
    projectId: 'project-1',
    status: 'working',
    activity: null,
    branch: null,
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: {
      id: sessionId,
      runtimeName: 'tmux',
      data: {},
    },
    agentInfo: null,
    createdAt: new Date(FIXED_TIME),
    lastActivityAt: new Date(FIXED_TIME),
    metadata: {},
  };
}

async function runAoExecWithPackets(planId: string, packets: TaskPacket[], maxDispatches?: number) {
  const rootDir = await mkdtemp(join(tmpdir(), 'dispatcher-ao-exec-'));
  const packetFilePath = join(rootDir, `${planId}.json`);
  const dispatchFilePath = resolveDispatchFilePath(planId);

  await writeFile(packetFilePath, `${JSON.stringify(packets, null, 2)}\n`, 'utf8');

  try {
    const spawnCalls: Array<Record<string, unknown>> = [];
    const sendCalls: Array<{ sessionId: string; instruction: string }> = [];

    const result = await runDispatcherAoExec(
      {
        planId,
        packetFile: packetFilePath,
        maxDispatches,
        timestamp: FIXED_TIME,
      },
      {
        createSessionManager: async () => ({
          spawn: async (config: Record<string, unknown>) => {
            spawnCalls.push(config);
            return createSession('spawned-session-1');
          },
          send: async (sessionId: string, instruction: string) => {
            sendCalls.push({ sessionId, instruction });
          },
        } as any),
      },
    );

    const persistedPackets = JSON.parse(await readFile(packetFilePath, 'utf8')) as TaskPacket[];
    return { result, persistedPackets, spawnCalls, sendCalls };
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await unlink(dispatchFilePath).catch(() => {});
  }
}

test('ready packet in dry-run mode is simulated and reported deterministically', async () => {
  const planId = 'plan-dry-run-simulated';
  const packet = createPacket({ planId, packetId: 'packet-ready' });
  const { result, persistedPackets } = await runWithPackets(planId, [packet]);

  assert.equal(result.dispatchedCount, 1);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0]?.reason, 'dry_run_simulated_dispatch');
  assert.equal(result.decisions[0]?.outcome, 'dispatched');
  assert.equal(result.dispatchedPacketIds[0], packet.packetId);
  assert.equal(result.decisionCounts.dry_run_simulated_dispatch, 1);
  assert.equal(persistedPackets[0]?.status, 'dispatching');
});

test('non-ready packet is skipped with skipped_not_ready', async () => {
  const planId = 'plan-dry-run-not-ready';
  const packet = createPacket({ planId, packetId: 'packet-waiting', status: 'waiting' });
  const { result, persistedPackets } = await runWithPackets(planId, [packet]);

  assert.equal(result.dispatchedCount, 0);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.decisions[0]?.reason, 'skipped_not_ready');
  assert.equal(result.decisions[0]?.outcome, 'skipped');
  assert.equal(result.decisionCounts.skipped_not_ready, 1);
  assert.equal(persistedPackets[0]?.status, 'waiting');
});

test('ready packet with existing sessionId is skipped with skipped_already_has_session', async () => {
  const planId = 'plan-dry-run-has-session';
  const packet = createPacket({
    planId,
    packetId: 'packet-existing-session',
    sessionId: 'session-existing',
  });
  const { result } = await runWithPackets(planId, [packet]);

  assert.equal(result.dispatchedCount, 0);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.decisions[0]?.reason, 'skipped_already_has_session');
  assert.equal(result.decisionCounts.skipped_already_has_session, 1);
});

test('risk or approval blocked packet is skipped with skipped_risk_or_approval_block', async () => {
  const planId = 'plan-dry-run-risk-block';
  const packet = createPacket({
    planId,
    packetId: 'packet-risk-blocked',
    approvalState: 'pending',
  });
  const { result } = await runWithPackets(planId, [packet]);

  assert.equal(result.dispatchedCount, 0);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.decisions[0]?.reason, 'skipped_risk_or_approval_block');
  assert.equal(result.decisionCounts.skipped_risk_or_approval_block, 1);
});

test('dispatcher result counts and decisions match packet outcomes', async () => {
  const planId = 'plan-dry-run-counts';
  const packets: TaskPacket[] = [
    createPacket({ planId, packetId: 'packet-dispatched' }),
    createPacket({
      planId,
      packetId: 'packet-dependency',
      status: 'queued',
      dependencies: ['packet-missing'],
    }),
    createPacket({
      planId,
      packetId: 'packet-session',
      sessionId: 'session-existing',
    }),
    createPacket({
      planId,
      packetId: 'packet-risk',
      riskTier: 'mutating',
    }),
    createPacket({ planId, packetId: 'packet-capacity' }),
    createPacket({
      planId,
      packetId: 'packet-not-ready',
      status: 'waiting',
    }),
  ];

  const { result } = await runWithPackets(planId, packets, 1);

  assert.equal(result.evaluatedCount, packets.length);
  assert.equal(result.decisions.length, packets.length);
  assert.equal(result.dispatchedCount, 1);
  assert.equal(result.skippedCount, 5);
  assert.deepEqual(result.dispatchedPacketIds, ['packet-dispatched']);
  assert.equal(result.decisionCounts.dry_run_simulated_dispatch, 1);
  assert.equal(result.decisionCounts.skipped_dependency_not_satisfied, 1);
  assert.equal(result.decisionCounts.skipped_already_has_session, 1);
  assert.equal(result.decisionCounts.skipped_risk_or_approval_block, 1);
  assert.equal(result.decisionCounts.skipped_no_dispatch_capacity, 1);
  assert.equal(result.decisionCounts.skipped_not_ready, 1);
});

test('dry-run decision reasons stay explicit and machine-friendly', async () => {
  const planId = 'plan-dry-run-reason-contract';
  const packets: TaskPacket[] = [
    createPacket({ planId, packetId: 'packet-dispatched' }),
    createPacket({
      planId,
      packetId: 'packet-dependency',
      status: 'queued',
      dependencies: ['packet-missing'],
    }),
    createPacket({
      planId,
      packetId: 'packet-session',
      sessionId: 'session-existing',
    }),
    createPacket({
      planId,
      packetId: 'packet-risk',
      riskTier: 'mutating',
    }),
    createPacket({ planId, packetId: 'packet-capacity' }),
    createPacket({
      planId,
      packetId: 'packet-not-ready',
      status: 'waiting',
    }),
  ];

  const { result } = await runWithPackets(planId, packets, 1);
  const knownReasons: DispatchDecisionReason[] = [
    'dispatched_to_session',
    'dry_run_marked_only',
    'dry_run_simulated_dispatch',
    'skipped_not_ready',
    'skipped_already_has_session',
    'skipped_dependency_not_satisfied',
    'skipped_risk_or_approval_block',
    'skipped_no_dispatch_capacity',
  ];

  assert.deepEqual(Object.keys(result.decisionCounts).sort(), [...knownReasons].sort());
  for (const decision of result.decisions) {
    assert.equal(knownReasons.includes(decision.reason), true);
    assert.match(decision.reason, /^[a-z]+(?:_[a-z]+)*$/);
  }
});

test('ao-exec spawns a new session when packet sessionId is missing and continues dispatch', async () => {
  const planId = 'plan-ao-exec-spawn';
  const packet = createPacket({
    planId,
    packetId: 'packet-spawn',
    sessionId: undefined,
    completionCriteria: {},
  });

  const { result, persistedPackets, spawnCalls, sendCalls } = await runAoExecWithPackets(planId, [packet]);

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0], {
    sessionId: 'packet-spawn',
    projectId: 'project-1',
    prompt: 'echo "dry-run"',
  });
  assert.equal(sendCalls.length, 0);

  assert.equal(result.dispatchedCount, 1);
  assert.equal(result.decisions[0]?.reason, 'dispatched_to_session');
  assert.equal(result.decisions[0]?.toStatus, 'waiting');

  assert.equal(persistedPackets[0]?.sessionId, 'spawned-session-1');
  assert.equal(persistedPackets[0]?.completionCriteria.expectedSessionId, 'spawned-session-1');
  assert.equal(persistedPackets[0]?.status, 'waiting');
});

test('ao-exec sends instruction to existing session when packet sessionId is already set', async () => {
  const planId = 'plan-ao-exec-existing-session';
  const packet = createPacket({
    planId,
    packetId: 'packet-existing',
    sessionId: 'session-existing',
    completionCriteria: {},
  });

  const { result, persistedPackets, spawnCalls, sendCalls } = await runAoExecWithPackets(planId, [packet]);

  assert.equal(spawnCalls.length, 0);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0]?.sessionId, 'session-existing');
  assert.equal(sendCalls[0]?.instruction, 'echo "dry-run"');

  assert.equal(result.dispatchedCount, 1);
  assert.equal(result.decisions[0]?.reason, 'dispatched_to_session');
  assert.equal(result.decisions[0]?.toStatus, 'waiting');

  assert.equal(persistedPackets[0]?.sessionId, 'session-existing');
  assert.equal(persistedPackets[0]?.completionCriteria.expectedSessionId, 'session-existing');
  assert.equal(persistedPackets[0]?.status, 'waiting');
});

test('ao-exec skips non-ready packet with skipped_not_ready', async () => {
  const planId = 'plan-ao-exec-not-ready';
  const packet = createPacket({
    planId,
    packetId: 'packet-not-ready',
    status: 'waiting',
  });

  const { result, persistedPackets, spawnCalls, sendCalls } = await runAoExecWithPackets(planId, [packet]);

  assert.equal(result.dispatchedCount, 0);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.decisions[0]?.reason, 'skipped_not_ready');
  assert.equal(result.decisions[0]?.outcome, 'skipped');
  assert.equal(result.decisionCounts.skipped_not_ready, 1);
  assert.equal(spawnCalls.length, 0);
  assert.equal(sendCalls.length, 0);
  assert.equal(persistedPackets[0]?.status, 'waiting');
});

test('ao-exec skips queued packet with unsatisfied dependency', async () => {
  const planId = 'plan-ao-exec-dependency-block';
  const packet = createPacket({
    planId,
    packetId: 'packet-dependency',
    status: 'queued',
    dependencies: ['packet-missing'],
  });

  const { result, persistedPackets, spawnCalls, sendCalls } = await runAoExecWithPackets(planId, [packet]);

  assert.equal(result.dispatchedCount, 0);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.decisions[0]?.reason, 'skipped_dependency_not_satisfied');
  assert.equal(result.decisions[0]?.outcome, 'skipped');
  assert.equal(result.decisionCounts.skipped_dependency_not_satisfied, 1);
  assert.equal(spawnCalls.length, 0);
  assert.equal(sendCalls.length, 0);
  assert.equal(persistedPackets[0]?.status, 'queued');
});

test('ao-exec skips risk or approval blocked packet', async () => {
  const planId = 'plan-ao-exec-risk-block';
  const packet = createPacket({
    planId,
    packetId: 'packet-risk-blocked',
    approvalState: 'pending',
  });

  const { result, persistedPackets, spawnCalls, sendCalls } = await runAoExecWithPackets(planId, [packet]);

  assert.equal(result.dispatchedCount, 0);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.decisions[0]?.reason, 'skipped_risk_or_approval_block');
  assert.equal(result.decisions[0]?.outcome, 'skipped');
  assert.equal(result.decisionCounts.skipped_risk_or_approval_block, 1);
  assert.equal(spawnCalls.length, 0);
  assert.equal(sendCalls.length, 0);
  assert.equal(persistedPackets[0]?.status, 'ready');
});

test('ao-exec skips ready packet when dispatch capacity is exhausted', async () => {
  const planId = 'plan-ao-exec-capacity';
  const packets: TaskPacket[] = [
    createPacket({
      planId,
      packetId: 'packet-dispatched',
      completionCriteria: {},
    }),
    createPacket({
      planId,
      packetId: 'packet-capacity-skipped',
      completionCriteria: {},
    }),
  ];

  const { result, persistedPackets, spawnCalls, sendCalls } = await runAoExecWithPackets(planId, packets, 1);

  assert.equal(result.dispatchedCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.decisions.length, 2);
  assert.equal(result.decisions[0]?.reason, 'dispatched_to_session');
  assert.equal(result.decisions[0]?.outcome, 'dispatched');
  assert.equal(result.decisions[1]?.reason, 'skipped_no_dispatch_capacity');
  assert.equal(result.decisions[1]?.outcome, 'skipped');
  assert.equal(result.decisionCounts.dispatched_to_session, 1);
  assert.equal(result.decisionCounts.skipped_no_dispatch_capacity, 1);
  assert.equal(spawnCalls.length, 1);
  assert.equal(sendCalls.length, 0);
  assert.equal(persistedPackets[0]?.status, 'waiting');
  assert.equal(persistedPackets[1]?.status, 'ready');
});
