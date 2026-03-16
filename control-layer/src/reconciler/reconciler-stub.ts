import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendExecutionLogEntry,
  createTimestamp,
} from '../logging/file-execution-log.js';
import {
  loadPlanState,
  readTaskPackets,
  savePlanState,
  writeTaskPackets,
} from '../state/file-state-store.js';
import type { ExecutionLogEntry } from '../types/execution-log.js';
import type { PlanState } from '../types/plan-state.js';
import type {
  ReconcileDecision,
  ReconcilerInput,
  ReconcileResult,
} from '../types/reconciler.js';
import type { TaskPacket } from '../types/task-packet.js';
import { hasRepeatedCompletionMarker } from './completion-marker.js';

import { loadConfig, tmuxCapturePane } from '../../../packages/core/dist/index.js';
import { getSessionManager } from '../../../packages/cli/dist/lib/create-session-manager.js';
import type { OpenCodeSessionManager, Session } from '../../../packages/core/dist/index.js';

const DEFAULT_ACTOR = 'control-layer-reconciler';

type ReconcilerSessionManager = Pick<OpenCodeSessionManager, 'get'>;
type RetryResolution = 'requeue' | 'exhausted';

export interface ReconcilerStubDependencies {
  stateRoot?: string;
  createSessionManager?: () => Promise<ReconcilerSessionManager>;
  capturePane?: (sessionId: string, lines: number) => Promise<string>;
}

function resolveControlLayerRoot(): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFilePath);
  return resolve(currentDir, '../..');
}

function resolveStatePaths(input: ReconcilerInput, stateRootOverride?: string): {
  stateRoot: string;
  packetFilePath: string;
  logFilePath: string;
} {
  const stateRoot = stateRootOverride ?? resolve(resolveControlLayerRoot(), 'state');

  const packetFilePath = input.packetFile
    ? resolve(process.cwd(), input.packetFile)
    : resolve(stateRoot, 'packets', `${input.planId}.json`);

  return {
    stateRoot,
    packetFilePath,
    logFilePath: resolve(stateRoot, 'logs', 'execution.jsonl'),
  };
}

function ensurePlanId(inputPlanId: string | undefined, packets: TaskPacket[], packetFilePath: string): string {
  if (inputPlanId) {
    return inputPlanId;
  }

  const packetPlanId = packets[0]?.planId;
  if (packetPlanId) {
    return packetPlanId;
  }

  throw new Error(`Could not infer plan id for packet file: ${packetFilePath}`);
}

function areDependenciesCompleted(packet: TaskPacket, packetsById: Map<string, TaskPacket>): boolean {
  return packet.dependencies.every((dependencyId) => {
    const dependency = packetsById.get(dependencyId);
    return dependency?.status === 'completed';
  });
}

function createPacketStatusLogEntry(
  packet: TaskPacket,
  actor: string,
  timestamp: string,
  beforeStatus: TaskPacket['status'],
  afterStatus: TaskPacket['status'],
  reason: string,
): ExecutionLogEntry {
  return {
    logId: `${packet.packetId}_log_reconcile_${afterStatus}_${timestamp}`,
    timestamp,
    correlationId: packet.correlationId,
    planId: packet.planId,
    packetId: packet.packetId,
    projectId: packet.projectId,
    sessionId: packet.sessionId,
    eventType: 'packet_status_changed',
    phase: 'reconciler',
    actor,
    result: 'info',
    message: `Packet moved from ${beforeStatus} to ${afterStatus} by reconciler.`,
    beforeStatus,
    afterStatus,
    metadata: {
      reason,
      localStub: false,
    },
  };
}

function createPlanCompletedLogEntry(
  plan: PlanState,
  actor: string,
  timestamp: string,
): ExecutionLogEntry {
  return {
    logId: `${plan.planId}_log_reconcile_plan_completed_${timestamp}`,
    timestamp,
    correlationId: `${plan.planId}_corr_plan_completion`,
    planId: plan.planId,
    projectId: plan.projectId,
    eventType: 'completion_evaluated',
    phase: 'reconciler',
    actor,
    result: 'success',
    message: 'Plan marked completed; all packets are completed.',
    metadata: {
      localStub: false,
    },
  };
}

function resolveRetryOutcome(packet: TaskPacket): {
  resolution: RetryResolution;
  toStatus: 'ready' | 'failed';
  reason: 'retry_requeued' | 'retry_exhausted';
} {
  const hasRetryRemaining = packet.attempt < packet.retryPolicy.maxAttempts;
  if (hasRetryRemaining) {
    return {
      resolution: 'requeue',
      toStatus: 'ready',
      reason: 'retry_requeued',
    };
  }

  return {
    resolution: 'exhausted',
    toStatus: 'failed',
    reason: 'retry_exhausted',
  };
}

function buildRetryErrorMessage(
  sessionId: string,
  session: Session,
  errorCode: string,
): string {
  return `Session ${sessionId} reached ${errorCode} (${session.status}${session.activity ? ` / ${session.activity}` : ''}).`;
}

async function createAoSessionManager(): Promise<OpenCodeSessionManager> {
  const config = loadConfig();
  return getSessionManager(config);
}

function isTerminalCompletionSession(session: Session): boolean {
  return (
    session.status === 'done' ||
    session.status === 'merged' ||
    session.status === 'terminated' ||
    session.status === 'killed' ||
    session.activity === 'exited'
  );
}

function isNeedsInputSession(session: Session): boolean {
  return (
    session.status === 'needs_input' ||
    session.status === 'stuck' ||
    session.status === 'errored' ||
    session.activity === 'waiting_input' ||
    session.activity === 'blocked'
  );
}

async function doesPacketCompletionMarkerExist(
  packet: TaskPacket,
  session: Session,
  capturePane: (sessionId: string, lines: number) => Promise<string>,
): Promise<boolean> {
  const marker =
    typeof packet.payload.completionMarker === 'string'
      ? packet.payload.completionMarker.trim()
      : '';

  const handle = session.runtimeHandle;
  if (!marker || !handle) {
    return false;
  }

  if (handle.runtimeName !== 'tmux') {
    return false;
  }

  const output = await capturePane(handle.id, 120).catch(() => '');
  if (typeof output !== 'string') {
    return false;
  }

  return hasRepeatedCompletionMarker(output, marker);
}

export async function runReconcilerStub(
  input: ReconcilerInput,
  dependencies: ReconcilerStubDependencies = {},
): Promise<ReconcileResult> {
  if (!input.planId && !input.packetFile) {
    throw new Error('Either planId or packetFile must be provided.');
  }

  const actor = input.actor ?? DEFAULT_ACTOR;
  const { stateRoot, packetFilePath, logFilePath } = resolveStatePaths(input, dependencies.stateRoot);
  const createSessionManager = dependencies.createSessionManager ?? createAoSessionManager;
  const capturePane = dependencies.capturePane ?? tmuxCapturePane;

  const packets = await readTaskPackets(packetFilePath);
  const planId = ensurePlanId(input.planId, packets, packetFilePath);
  const planFilePath = resolve(stateRoot, 'plans', `${planId}.json`);
  const plan = await loadPlanState(planFilePath);

  if (!plan) {
    throw new Error(`Plan state not found: ${planFilePath}`);
  }

  if (plan.planId !== planId) {
    throw new Error(`Plan id mismatch between inputs (${planId}) and plan file (${plan.planId}).`);
  }

  const packetsById = new Map(packets.map((packet) => [packet.packetId, packet]));
  const packetStatusBeforeById = new Map(packets.map((packet) => [packet.packetId, packet.status]));
  const decisions: ReconcileDecision[] = [];
  const logEntries: ExecutionLogEntry[] = [];

  let sessionManager: ReconcilerSessionManager | null = null;

  for (const packet of packets) {
    if (packet.status !== 'waiting') {
      continue;
    }

    const timestamp = input.timestamp ?? createTimestamp();

    if (!packet.sessionId?.trim()) {
      packet.status = 'completed';
      packet.completedAt = timestamp;
      packet.updatedAt = timestamp;

      decisions.push({
        kind: 'packet_completed',
        planId,
        packetId: packet.packetId,
        fromStatus: 'waiting',
        toStatus: 'completed',
        reason: 'stub_waiting_locally_completable',
        correlationId: packet.correlationId,
      });

      logEntries.push(
        createPacketStatusLogEntry(
          packet,
          actor,
          timestamp,
          'waiting',
          'completed',
          'stub_waiting_locally_completable',
        ),
      );
      continue;
    }

    if (!sessionManager) {
      sessionManager = await createSessionManager();
    }

    const session = await sessionManager.get(packet.sessionId);

    if (!session) {
      continue;
    }

    if (await doesPacketCompletionMarkerExist(packet, session, capturePane)) {
      packet.status = 'completed';
      packet.completedAt = timestamp;
      packet.updatedAt = timestamp;
      packet.lastErrorCode = undefined;
      packet.lastErrorMessage = undefined;

      decisions.push({
        kind: 'packet_completed',
        planId,
        packetId: packet.packetId,
        fromStatus: 'waiting',
        toStatus: 'completed',
        reason: 'ao_session_terminal',
        correlationId: packet.correlationId,
      });

      logEntries.push(
        createPacketStatusLogEntry(
          packet,
          actor,
          timestamp,
          'waiting',
          'completed',
          'ao_session_terminal',
        ),
      );
      continue;
    }

    const terminalWithoutMarker = isTerminalCompletionSession(session);
    const blockedOrErrored = isNeedsInputSession(session);
    if (!terminalWithoutMarker && !blockedOrErrored) {
      continue;
    }

    const baseErrorCode = terminalWithoutMarker
      ? 'ao_session_terminal_without_completion_marker'
      : 'ao_session_needs_input';
    const baseDecisionReason = terminalWithoutMarker
      ? 'ao_session_terminal_without_completion_marker'
      : 'ao_session_needs_input';
    const retryOutcome = resolveRetryOutcome(packet);
    const sessionId = packet.sessionId;
    if (!sessionId) {
      continue;
    }

    if (retryOutcome.resolution === 'requeue') {
      const errorMessage = buildRetryErrorMessage(sessionId, session, baseErrorCode);
      packet.status = 'ready';
      packet.attempt += 1;
      packet.updatedAt = timestamp;
      packet.sessionId = undefined;
      packet.startedAt = undefined;
      packet.completedAt = undefined;
      packet.nextAttemptAt = undefined;
      packet.lastErrorCode = baseErrorCode;
      packet.lastErrorMessage = errorMessage;

      decisions.push({
        kind: 'packet_requeued',
        planId,
        packetId: packet.packetId,
        fromStatus: 'waiting',
        toStatus: 'ready',
        reason: retryOutcome.reason,
        correlationId: packet.correlationId,
      });

      logEntries.push(
        createPacketStatusLogEntry(
          packet,
          actor,
          timestamp,
          'waiting',
          'ready',
          `${baseDecisionReason}:${retryOutcome.reason}`,
        ),
      );
      continue;
    }

    packet.status = 'failed';
    packet.updatedAt = timestamp;
    packet.lastErrorCode = baseErrorCode;
    packet.lastErrorMessage = buildRetryErrorMessage(sessionId, session, baseErrorCode);

    decisions.push({
      kind: 'packet_failed',
      planId,
      packetId: packet.packetId,
      fromStatus: 'waiting',
      toStatus: 'failed',
      reason: retryOutcome.reason,
      correlationId: packet.correlationId,
    });

    logEntries.push(
      createPacketStatusLogEntry(
        packet,
        actor,
        timestamp,
        'waiting',
        'failed',
        `${baseDecisionReason}:${retryOutcome.reason}`,
      ),
    );
  }

  for (const packet of packets) {
    if (packet.status !== 'queued') {
      continue;
    }

    if (!areDependenciesCompleted(packet, packetsById)) {
      continue;
    }

    const timestamp = input.timestamp ?? createTimestamp();
    packet.status = 'ready';
    packet.updatedAt = timestamp;

    decisions.push({
      kind: 'packet_unlocked',
      planId,
      packetId: packet.packetId,
      fromStatus: 'queued',
      toStatus: 'ready',
      reason: 'dependencies_satisfied',
      correlationId: packet.correlationId,
    });

    logEntries.push(
      createPacketStatusLogEntry(
        packet,
        actor,
        timestamp,
        'queued',
        'ready',
        'dependencies_satisfied',
      ),
    );
  }

  const completedPacketIds = packets
    .filter((packet) => packet.status === 'completed')
    .map((packet) => packet.packetId);
  const openPacketIds = packets
    .filter((packet) => packet.status !== 'completed' && packet.status !== 'cancelled')
    .map((packet) => packet.packetId);

  plan.completedPacketIds = completedPacketIds;
  plan.openPacketIds = openPacketIds;

  const isPlanComplete = packets.length > 0 && completedPacketIds.length === packets.length;
  const planWasCompleted = plan.status === 'completed';
  const previousPlanStatus = plan.status;

  if (isPlanComplete) {
    plan.status = 'completed';
    if (!planWasCompleted) {
      decisions.push({
        kind: 'plan_completed',
        planId,
        fromStatus: previousPlanStatus,
        toStatus: 'completed',
        reason: 'all_packets_completed',
      });
      const timestamp = input.timestamp ?? createTimestamp();
      logEntries.push(createPlanCompletedLogEntry(plan, actor, timestamp));
    }
  }

  plan.updatedAt = input.timestamp ?? createTimestamp();

  await writeTaskPackets(packetFilePath, packets);
  await savePlanState(planFilePath, plan);

  for (const logEntry of logEntries) {
    await appendExecutionLogEntry(logFilePath, logEntry);
  }

  const completedCount = packets.filter((packet) => {
    const beforeStatus = packetStatusBeforeById.get(packet.packetId);
    return beforeStatus !== 'completed' && packet.status === 'completed';
  }).length;

  const unlockedCount = packets.filter((packet) => {
    const beforeStatus = packetStatusBeforeById.get(packet.packetId);
    return beforeStatus === 'queued' && packet.status === 'ready';
  }).length;

  const requeuedCount = decisions.filter((decision) => decision.kind === 'packet_requeued').length;
  const failedCount = decisions.filter((decision) => decision.kind === 'packet_failed').length;
  const planCompleted = plan.status === 'completed';

  return {
    planId,
    planFilePath,
    packetFilePath,
    evaluatedPacketCount: packets.length,
    completedCount,
    requeuedCount,
    failedCount,
    unlockedCount,
    planCompleted,
    summary: {
      completedPackets: completedCount,
      requeuedPackets: requeuedCount,
      failedPackets: failedCount,
      unlockedPackets: unlockedCount,
      planCompleted,
    },
    decisions,
  };
}
