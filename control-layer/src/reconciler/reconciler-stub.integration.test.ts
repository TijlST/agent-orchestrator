import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Session } from '../../../packages/core/dist/index.js';
import { runReconcilerStub } from './reconciler-stub.js';
import type { ExecutionLogEntry } from '../types/execution-log.js';
import type { PlanState } from '../types/plan-state.js';
import type { TaskPacket } from '../types/task-packet.js';

const FIXED_TIME = '2026-03-16T12:00:00.000Z';

function createPacket(overrides: Partial<TaskPacket>): TaskPacket {
  const packetId = overrides.packetId ?? 'packet-1';
  const planId = overrides.planId ?? 'plan-1';
  const projectId = overrides.projectId ?? 'proj-1';

  return {
    packetId,
    planId,
    projectId,
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

function createSession(
  sessionId: string,
  overrides: Partial<Session> = {},
): Session {
  return {
    id: sessionId,
    projectId: 'proj-1',
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
    ...overrides,
  };
}

async function setupFixture(planId: string, packets: TaskPacket[]): Promise<{
  rootDir: string;
  packetFilePath: string;
  planFilePath: string;
  stateRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'reconciler-stub-it-'));
  const stateRoot = join(root, 'state');
  const packetFilePath = join(stateRoot, 'packets', `${planId}.json`);
  const planFilePath = join(stateRoot, 'plans', `${planId}.json`);

  const completedPacketIds = packets
    .filter((packet) => packet.status === 'completed')
    .map((packet) => packet.packetId);
  const openPacketIds = packets
    .filter((packet) => packet.status !== 'completed' && packet.status !== 'cancelled')
    .map((packet) => packet.packetId);

  const plan: PlanState = {
    planId,
    goal: 'test goal',
    projectId: packets[0]?.projectId ?? 'proj-1',
    status: 'active',
    packetIds: packets.map((packet) => packet.packetId),
    openPacketIds,
    completedPacketIds,
    retryBudgetRemaining: 3,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  };

  await mkdir(join(stateRoot, 'packets'), { recursive: true });
  await mkdir(join(stateRoot, 'plans'), { recursive: true });

  await writeFile(packetFilePath, `${JSON.stringify(packets, null, 2)}\n`, 'utf8');
  await writeFile(planFilePath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

  return { rootDir: root, packetFilePath, planFilePath, stateRoot };
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function readExecutionLogEntries(stateRoot: string): Promise<ExecutionLogEntry[]> {
  const logFilePath = join(stateRoot, 'logs', 'execution.jsonl');

  try {
    const content = await readFile(logFilePath, 'utf8');
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      return [];
    }

    return trimmedContent
      .split('\n')
      .map((line) => JSON.parse(line) as ExecutionLogEntry);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

test('waiting packet with no sessionId transitions to completed', async () => {
  const planId = 'plan-local-complete';
  const packet = createPacket({
    packetId: 'packet-local',
    planId,
    status: 'waiting',
  });
  const fixture = await setupFixture(planId, [packet]);

  try {
    const result = await runReconcilerStub(
      {
        planId,
        packetFile: fixture.packetFilePath,
        timestamp: FIXED_TIME,
      },
      {
        stateRoot: fixture.stateRoot,
        createSessionManager: async () => {
          throw new Error('session manager should not be created');
        },
      },
    );

    const updatedPackets = await readJsonFile<TaskPacket[]>(fixture.packetFilePath);
    const executionEntries = await readExecutionLogEntries(fixture.stateRoot);
    const statusLog = executionEntries.find(
      (entry) =>
        entry.eventType === 'packet_status_changed' &&
        entry.packetId === 'packet-local' &&
        entry.beforeStatus === 'waiting' &&
        entry.afterStatus === 'completed',
    );

    assert.equal(updatedPackets[0]?.status, 'completed');
    assert.equal(updatedPackets[0]?.completedAt, FIXED_TIME);
    assert.equal(result.completedCount, 1);
    assert.equal(result.requeuedCount, 0);
    assert.equal(result.failedCount, 0);
    assert.equal(
      result.decisions.some(
        (decision) =>
          decision.kind === 'packet_completed' &&
          decision.packetId === 'packet-local' &&
          decision.reason === 'stub_waiting_locally_completable',
      ),
      true,
    );
    assert.equal(Boolean(statusLog), true);
    assert.equal(statusLog?.phase, 'reconciler');
    assert.equal(statusLog?.metadata?.reason, 'stub_waiting_locally_completable');
  } finally {
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});

test('waiting packet with repeated completion marker transitions to completed', async () => {
  const planId = 'plan-marker-complete';
  const marker = 'CONTROL_LAYER_DONE:packet-remote';
  const sessionId = 'session-remote';
  const packet = createPacket({
    packetId: 'packet-remote',
    planId,
    sessionId,
    status: 'waiting',
    payload: { completionMarker: marker },
  });
  const fixture = await setupFixture(planId, [packet]);

  let getCalls = 0;
  let paneCalls = 0;

  try {
    const result = await runReconcilerStub(
      {
        planId,
        packetFile: fixture.packetFilePath,
        timestamp: FIXED_TIME,
      },
      {
        stateRoot: fixture.stateRoot,
        createSessionManager: async () => ({
          get: async (id: string) => {
            getCalls += 1;
            return id === sessionId ? createSession(sessionId) : null;
          },
        }),
        capturePane: async () => {
          paneCalls += 1;
          return [
            `Instruction: print ${marker} once when done.`,
            'work in progress',
            `Final output: ${marker}`,
          ].join('\n');
        },
      },
    );

    const updatedPackets = await readJsonFile<TaskPacket[]>(fixture.packetFilePath);
    assert.equal(updatedPackets[0]?.status, 'completed');
    assert.equal(result.completedCount, 1);
    assert.equal(getCalls, 1);
    assert.equal(paneCalls, 1);
  } finally {
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});

test('waiting packet with a single completion marker occurrence stays waiting', async () => {
  const planId = 'plan-marker-pending';
  const marker = 'CONTROL_LAYER_DONE:packet-pending';
  const sessionId = 'session-pending';
  const packet = createPacket({
    packetId: 'packet-pending',
    planId,
    sessionId,
    status: 'waiting',
    payload: { completionMarker: marker },
  });
  const fixture = await setupFixture(planId, [packet]);

  try {
    const result = await runReconcilerStub(
      {
        planId,
        packetFile: fixture.packetFilePath,
        timestamp: FIXED_TIME,
      },
      {
        stateRoot: fixture.stateRoot,
        createSessionManager: async () => ({
          get: async () => createSession(sessionId),
        }),
        capturePane: async () => `Only once: ${marker}`,
      },
    );

    const updatedPackets = await readJsonFile<TaskPacket[]>(fixture.packetFilePath);
    assert.equal(updatedPackets[0]?.status, 'waiting');
    assert.equal(result.completedCount, 0);
    assert.equal(result.planCompleted, false);
  } finally {
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});

test('needs-input session with retry remaining requeues waiting packet to ready and increments attempt', async () => {
  const planId = 'plan-needs-input-retry';
  const sessionId = 'session-needs-input-retry';
  const packet = createPacket({
    packetId: 'packet-needs-input-retry',
    planId,
    sessionId,
    status: 'waiting',
    attempt: 0,
    retryPolicy: {
      maxAttempts: 1,
      backoffMsBase: 1000,
      backoffMultiplier: 1,
      maxBackoffMs: 1000,
      retryOn: [],
    },
  });
  const fixture = await setupFixture(planId, [packet]);

  try {
    const result = await runReconcilerStub(
      {
        planId,
        packetFile: fixture.packetFilePath,
        timestamp: FIXED_TIME,
      },
      {
        stateRoot: fixture.stateRoot,
        createSessionManager: async () => ({
          get: async () => createSession(sessionId, { status: 'needs_input' }),
        }),
      },
    );

    const updatedPackets = await readJsonFile<TaskPacket[]>(fixture.packetFilePath);
    const executionEntries = await readExecutionLogEntries(fixture.stateRoot);
    const statusLog = executionEntries.find(
      (entry) =>
        entry.eventType === 'packet_status_changed' &&
        entry.packetId === 'packet-needs-input-retry' &&
        entry.beforeStatus === 'waiting' &&
        entry.afterStatus === 'ready',
    );

    assert.equal(updatedPackets[0]?.status, 'ready');
    assert.equal(updatedPackets[0]?.attempt, 1);
    assert.equal(updatedPackets[0]?.sessionId, undefined);
    assert.equal(updatedPackets[0]?.lastErrorCode, 'ao_session_needs_input');
    assert.equal(result.requeuedCount, 1);
    assert.equal(result.failedCount, 0);
    assert.equal(
      result.decisions.some(
        (decision) =>
          decision.kind === 'packet_requeued' &&
          decision.packetId === 'packet-needs-input-retry' &&
          decision.reason === 'retry_requeued',
      ),
      true,
    );
    assert.equal(Boolean(statusLog), true);
    assert.equal(statusLog?.metadata?.reason, 'ao_session_needs_input:retry_requeued');
  } finally {
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});

test('errored session with no retries remaining moves packet to failed', async () => {
  const planId = 'plan-errored-exhausted';
  const sessionId = 'session-errored-exhausted';
  const packet = createPacket({
    packetId: 'packet-errored-exhausted',
    planId,
    sessionId,
    status: 'waiting',
    attempt: 1,
    retryPolicy: {
      maxAttempts: 1,
      backoffMsBase: 1000,
      backoffMultiplier: 1,
      maxBackoffMs: 1000,
      retryOn: [],
    },
  });
  const fixture = await setupFixture(planId, [packet]);

  try {
    const result = await runReconcilerStub(
      {
        planId,
        packetFile: fixture.packetFilePath,
        timestamp: FIXED_TIME,
      },
      {
        stateRoot: fixture.stateRoot,
        createSessionManager: async () => ({
          get: async () => createSession(sessionId, { status: 'errored' }),
        }),
      },
    );

    const updatedPackets = await readJsonFile<TaskPacket[]>(fixture.packetFilePath);
    const executionEntries = await readExecutionLogEntries(fixture.stateRoot);
    const statusLog = executionEntries.find(
      (entry) =>
        entry.eventType === 'packet_status_changed' &&
        entry.packetId === 'packet-errored-exhausted' &&
        entry.beforeStatus === 'waiting' &&
        entry.afterStatus === 'failed',
    );

    assert.equal(updatedPackets[0]?.status, 'failed');
    assert.equal(updatedPackets[0]?.attempt, 1);
    assert.equal(updatedPackets[0]?.lastErrorCode, 'ao_session_needs_input');
    assert.equal(result.requeuedCount, 0);
    assert.equal(result.failedCount, 1);
    assert.equal(
      result.decisions.some(
        (decision) =>
          decision.kind === 'packet_failed' &&
          decision.packetId === 'packet-errored-exhausted' &&
          decision.reason === 'retry_exhausted',
      ),
      true,
    );
    assert.equal(Boolean(statusLog), true);
    assert.equal(statusLog?.metadata?.reason, 'ao_session_needs_input:retry_exhausted');
  } finally {
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});

test('terminal session without repeated completion marker requeues when retry remains', async () => {
  const planId = 'plan-terminal-no-marker-retry';
  const marker = 'CONTROL_LAYER_DONE:packet-terminal-retry';
  const sessionId = 'session-terminal-retry';
  const packet = createPacket({
    packetId: 'packet-terminal-retry',
    planId,
    sessionId,
    status: 'waiting',
    attempt: 0,
    payload: { completionMarker: marker },
    retryPolicy: {
      maxAttempts: 1,
      backoffMsBase: 1000,
      backoffMultiplier: 1,
      maxBackoffMs: 1000,
      retryOn: [],
    },
  });
  const fixture = await setupFixture(planId, [packet]);

  try {
    const result = await runReconcilerStub(
      {
        planId,
        packetFile: fixture.packetFilePath,
        timestamp: FIXED_TIME,
      },
      {
        stateRoot: fixture.stateRoot,
        createSessionManager: async () => ({
          get: async () => createSession(sessionId, { status: 'done' }),
        }),
        capturePane: async () => `single marker only: ${marker}`,
      },
    );

    const updatedPackets = await readJsonFile<TaskPacket[]>(fixture.packetFilePath);
    assert.equal(updatedPackets[0]?.status, 'ready');
    assert.equal(updatedPackets[0]?.attempt, 1);
    assert.equal(updatedPackets[0]?.sessionId, undefined);
    assert.equal(
      result.decisions.some(
        (decision) =>
          decision.kind === 'packet_requeued' &&
          decision.packetId === 'packet-terminal-retry' &&
          decision.reason === 'retry_requeued',
      ),
      true,
    );
  } finally {
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});

test('terminal session without repeated completion marker fails when retries are exhausted', async () => {
  const planId = 'plan-terminal-no-marker-exhausted';
  const marker = 'CONTROL_LAYER_DONE:packet-terminal-failed';
  const sessionId = 'session-terminal-failed';
  const packet = createPacket({
    packetId: 'packet-terminal-failed',
    planId,
    sessionId,
    status: 'waiting',
    attempt: 1,
    payload: { completionMarker: marker },
    retryPolicy: {
      maxAttempts: 1,
      backoffMsBase: 1000,
      backoffMultiplier: 1,
      maxBackoffMs: 1000,
      retryOn: [],
    },
  });
  const fixture = await setupFixture(planId, [packet]);

  try {
    const result = await runReconcilerStub(
      {
        planId,
        packetFile: fixture.packetFilePath,
        timestamp: FIXED_TIME,
      },
      {
        stateRoot: fixture.stateRoot,
        createSessionManager: async () => ({
          get: async () => createSession(sessionId, { status: 'done' }),
        }),
        capturePane: async () => `single marker only: ${marker}`,
      },
    );

    const updatedPackets = await readJsonFile<TaskPacket[]>(fixture.packetFilePath);
    assert.equal(updatedPackets[0]?.status, 'failed');
    assert.equal(updatedPackets[0]?.attempt, 1);
    assert.equal(
      updatedPackets[0]?.lastErrorCode,
      'ao_session_terminal_without_completion_marker',
    );
    assert.equal(
      result.decisions.some(
        (decision) =>
          decision.kind === 'packet_failed' &&
          decision.packetId === 'packet-terminal-failed' &&
          decision.reason === 'retry_exhausted',
      ),
      true,
    );
  } finally {
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});

test('queued dependent packet unlocks when dependency completes in the same reconcile run', async () => {
  const planId = 'plan-dependency-unlock';
  const packetA = createPacket({
    packetId: 'packet-a',
    planId,
    status: 'waiting',
  });
  const packetB = createPacket({
    packetId: 'packet-b',
    planId,
    status: 'queued',
    dependencies: ['packet-a'],
  });
  const fixture = await setupFixture(planId, [packetA, packetB]);

  try {
    const result = await runReconcilerStub(
      {
        planId,
        packetFile: fixture.packetFilePath,
        timestamp: FIXED_TIME,
      },
      {
        stateRoot: fixture.stateRoot,
        createSessionManager: async () => {
          throw new Error('session manager should not be created');
        },
      },
    );

    const updatedPackets = await readJsonFile<TaskPacket[]>(fixture.packetFilePath);
    const updatedA = updatedPackets.find((packet) => packet.packetId === 'packet-a');
    const updatedB = updatedPackets.find((packet) => packet.packetId === 'packet-b');
    const executionEntries = await readExecutionLogEntries(fixture.stateRoot);
    const unlockLog = executionEntries.find(
      (entry) =>
        entry.eventType === 'packet_status_changed' &&
        entry.packetId === 'packet-b' &&
        entry.beforeStatus === 'queued' &&
        entry.afterStatus === 'ready',
    );

    assert.equal(updatedA?.status, 'completed');
    assert.equal(updatedB?.status, 'ready');
    assert.equal(result.completedCount, 1);
    assert.equal(result.requeuedCount, 0);
    assert.equal(result.failedCount, 0);
    assert.equal(result.unlockedCount, 1);
    assert.equal(Boolean(unlockLog), true);
    assert.equal(unlockLog?.metadata?.reason, 'dependencies_satisfied');
  } finally {
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});

test('queued dependent packet stays queued when dependency is not completed', async () => {
  const planId = 'plan-dependency-no-unlock-not-completed';
  const packetA = createPacket({
    packetId: 'packet-a-not-completed',
    planId,
    status: 'ready',
  });
  const packetB = createPacket({
    packetId: 'packet-b-still-queued',
    planId,
    status: 'queued',
    dependencies: ['packet-a-not-completed'],
  });
  const fixture = await setupFixture(planId, [packetA, packetB]);

  try {
    const result = await runReconcilerStub(
      {
        planId,
        packetFile: fixture.packetFilePath,
        timestamp: FIXED_TIME,
      },
      {
        stateRoot: fixture.stateRoot,
        createSessionManager: async () => {
          throw new Error('session manager should not be created');
        },
      },
    );

    const updatedPackets = await readJsonFile<TaskPacket[]>(fixture.packetFilePath);
    const updatedB = updatedPackets.find((packet) => packet.packetId === 'packet-b-still-queued');

    assert.equal(updatedB?.status, 'queued');
    assert.equal(result.unlockedCount, 0);
    assert.equal(
      result.decisions.some(
        (decision) =>
          decision.kind === 'packet_unlocked' &&
          decision.packetId === 'packet-b-still-queued',
      ),
      false,
    );
  } finally {
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});

test('queued dependent packet does not unlock when dependency fails terminally', async () => {
  const planId = 'plan-dependency-no-unlock-failed';
  const marker = 'CONTROL_LAYER_DONE:packet-a-failed';
  const sessionId = 'session-a-failed';
  const packetA = createPacket({
    packetId: 'packet-a-failed',
    planId,
    status: 'waiting',
    sessionId,
    attempt: 1,
    payload: { completionMarker: marker },
    retryPolicy: {
      maxAttempts: 1,
      backoffMsBase: 1000,
      backoffMultiplier: 1,
      maxBackoffMs: 1000,
      retryOn: [],
    },
  });
  const packetB = createPacket({
    packetId: 'packet-b-blocked',
    planId,
    status: 'queued',
    dependencies: ['packet-a-failed'],
  });
  const fixture = await setupFixture(planId, [packetA, packetB]);

  try {
    const result = await runReconcilerStub(
      {
        planId,
        packetFile: fixture.packetFilePath,
        timestamp: FIXED_TIME,
      },
      {
        stateRoot: fixture.stateRoot,
        createSessionManager: async () => ({
          get: async () => createSession(sessionId, { status: 'done' }),
        }),
        capturePane: async () => `single marker only: ${marker}`,
      },
    );

    const updatedPackets = await readJsonFile<TaskPacket[]>(fixture.packetFilePath);
    const updatedA = updatedPackets.find((packet) => packet.packetId === 'packet-a-failed');
    const updatedB = updatedPackets.find((packet) => packet.packetId === 'packet-b-blocked');

    assert.equal(updatedA?.status, 'failed');
    assert.equal(updatedB?.status, 'queued');
    assert.equal(result.unlockedCount, 0);
    assert.equal(
      result.decisions.some(
        (decision) =>
          decision.kind === 'packet_unlocked' &&
          decision.packetId === 'packet-b-blocked',
      ),
      false,
    );
  } finally {
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});

test('plan is marked completed when all packets are completed', async () => {
  const planId = 'plan-completed';
  const packetA = createPacket({
    packetId: 'packet-1',
    planId,
    status: 'waiting',
  });
  const packetB = createPacket({
    packetId: 'packet-2',
    planId,
    status: 'waiting',
  });
  const fixture = await setupFixture(planId, [packetA, packetB]);

  try {
    const result = await runReconcilerStub(
      {
        planId,
        packetFile: fixture.packetFilePath,
        timestamp: FIXED_TIME,
      },
      {
        stateRoot: fixture.stateRoot,
        createSessionManager: async () => {
          throw new Error('session manager should not be created');
        },
      },
    );

    const updatedPlan = await readJsonFile<PlanState>(fixture.planFilePath);
    const executionEntries = await readExecutionLogEntries(fixture.stateRoot);
    const completionLog = executionEntries.find(
      (entry) => entry.eventType === 'completion_evaluated' && entry.planId === planId,
    );

    assert.equal(updatedPlan.status, 'completed');
    assert.deepEqual(updatedPlan.openPacketIds, []);
    assert.deepEqual(updatedPlan.completedPacketIds.sort(), ['packet-1', 'packet-2']);
    assert.equal(result.planCompleted, true);
    assert.equal(result.summary.planCompleted, true);
    assert.equal(result.summary.completedPackets, 2);
    assert.equal(result.summary.requeuedPackets, 0);
    assert.equal(result.summary.failedPackets, 0);
    assert.equal(result.summary.unlockedPackets, 0);
    assert.equal(
      result.decisions.some(
        (decision) => decision.kind === 'plan_completed' && decision.reason === 'all_packets_completed',
      ),
      true,
    );
    assert.equal(Boolean(completionLog), true);
    assert.equal(completionLog?.phase, 'reconciler');
  } finally {
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});

test('execution log file contains expected reconcile entries for a local state-driven run', async () => {
  const planId = 'plan-execution-log-audit';
  const packetA = createPacket({
    packetId: 'packet-audit-a',
    planId,
    status: 'waiting',
  });
  const packetB = createPacket({
    packetId: 'packet-audit-b',
    planId,
    status: 'queued',
    dependencies: ['packet-audit-a'],
  });
  const fixture = await setupFixture(planId, [packetA, packetB]);

  try {
    await runReconcilerStub(
      {
        planId,
        packetFile: fixture.packetFilePath,
        timestamp: FIXED_TIME,
      },
      {
        stateRoot: fixture.stateRoot,
        createSessionManager: async () => {
          throw new Error('session manager should not be created');
        },
      },
    );

    const executionEntries = await readExecutionLogEntries(fixture.stateRoot);
    assert.equal(executionEntries.length >= 2, true);
    assert.equal(
      executionEntries.some(
        (entry) =>
          entry.eventType === 'packet_status_changed' &&
          entry.packetId === 'packet-audit-a' &&
          entry.beforeStatus === 'waiting' &&
          entry.afterStatus === 'completed' &&
          entry.metadata?.reason === 'stub_waiting_locally_completable',
      ),
      true,
    );
    assert.equal(
      executionEntries.some(
        (entry) =>
          entry.eventType === 'packet_status_changed' &&
          entry.packetId === 'packet-audit-b' &&
          entry.beforeStatus === 'queued' &&
          entry.afterStatus === 'ready' &&
          entry.metadata?.reason === 'dependencies_satisfied',
      ),
      true,
    );
  } finally {
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});
