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
  ReconcilerExecutionEvent,
  ReconcilerInput,
  ReconcileResult,
} from '../types/reconciler.js';
import type { TaskPacket } from '../types/task-packet.js';
import { hasRepeatedCompletionMarker } from './completion-marker.js';

import { loadConfig, tmuxCapturePane } from '../../../packages/core/dist/index.js';
import { getSessionManager } from '../../../packages/cli/dist/lib/create-session-manager.js';
import type { OpenCodeSessionManager, Session } from '../../../packages/core/dist/index.js';

const DEFAULT_ACTOR = 'control-layer-reconciler';
const DEFAULT_RETRY_MAX_ATTEMPTS = 3;

type ReconcilerSessionManager = Pick<OpenCodeSessionManager, 'get'>;
type RetryResolution = 'requeue' | 'exhausted';
type SessionIdentityBlockReason =
  | 'missing_session_identity'
  | 'session_identity_mismatch'
  | 'ao_session_lookup_unresolved';

interface SessionIdentityResolution {
  ok: boolean;
  packetSessionId?: string;
  expectedSessionId?: string;
  lookupSessionId?: string;
  reason?: SessionIdentityBlockReason;
}

type TaskPacketWithRuntimeOptionalFields = TaskPacket & {
  dependencies?: unknown;
  completionCriteria?: unknown;
  retryPolicy?: unknown;
};

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

function readPacketDependencies(packet: TaskPacket): string[] {
  const dependencies = (packet as TaskPacketWithRuntimeOptionalFields).dependencies;
  if (!Array.isArray(dependencies)) {
    return [];
  }

  return dependencies.filter((dependencyId): dependencyId is string => typeof dependencyId === 'string');
}

function readPacketExpectedSessionId(packet: TaskPacket): string | undefined {
  const completionCriteria = (packet as TaskPacketWithRuntimeOptionalFields).completionCriteria;
  if (
    typeof completionCriteria !== 'object' ||
    completionCriteria === null ||
    Array.isArray(completionCriteria)
  ) {
    return undefined;
  }

  const expectedSessionId = (completionCriteria as { expectedSessionId?: unknown }).expectedSessionId;
  return typeof expectedSessionId === 'string' ? expectedSessionId : undefined;
}

function readPacketMaxAttempts(packet: TaskPacket): number {
  const retryPolicy = (packet as TaskPacketWithRuntimeOptionalFields).retryPolicy;
  if (
    typeof retryPolicy !== 'object' ||
    retryPolicy === null ||
    Array.isArray(retryPolicy)
  ) {
    return DEFAULT_RETRY_MAX_ATTEMPTS;
  }

  const rawMaxAttempts = (retryPolicy as { maxAttempts?: unknown }).maxAttempts;
  if (typeof rawMaxAttempts !== 'number' || !Number.isFinite(rawMaxAttempts)) {
    return DEFAULT_RETRY_MAX_ATTEMPTS;
  }

  const normalizedMaxAttempts = Math.floor(rawMaxAttempts);
  return normalizedMaxAttempts >= 1 ? normalizedMaxAttempts : DEFAULT_RETRY_MAX_ATTEMPTS;
}

function areDependenciesCompleted(packet: TaskPacket, packetsById: Map<string, TaskPacket>): boolean {
  return readPacketDependencies(packet).every((dependencyId) => {
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

function normalizeSessionId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizePacketId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function scopeIncomingExecutionEventsByPacket(
  incomingEvents: ReconcilerExecutionEvent[] | undefined,
  packetIds: Set<string>,
): Map<string, string[]> | undefined {
  if (!incomingEvents) {
    return undefined;
  }

  const scoped = new Map<string, Set<string>>();
  for (const event of incomingEvents) {
    const packetId = normalizePacketId(event.packetId);
    const sessionId = normalizeSessionId(event.sessionId);
    if (!packetId || !sessionId || !packetIds.has(packetId)) {
      continue;
    }

    const sessionIdsForPacket = scoped.get(packetId) ?? new Set<string>();
    sessionIdsForPacket.add(sessionId);
    scoped.set(packetId, sessionIdsForPacket);
  }

  return new Map(
    [...scoped.entries()].map(([packetId, sessionIdsForPacket]) => [
      packetId,
      [...sessionIdsForPacket].sort((left, right) => left.localeCompare(right)),
    ]),
  );
}

function resolveRequiredPacketSessionIdentity(packet: TaskPacket): SessionIdentityResolution {
  const packetSessionId = normalizeSessionId(packet.sessionId);
  const expectedSessionId = normalizeSessionId(readPacketExpectedSessionId(packet));

  if (!packetSessionId || !expectedSessionId) {
    return {
      ok: false,
      reason: 'missing_session_identity',
      packetSessionId,
      expectedSessionId,
    };
  }

  if (packetSessionId !== expectedSessionId) {
    return {
      ok: false,
      reason: 'session_identity_mismatch',
      packetSessionId,
      expectedSessionId,
    };
  }

  return {
    ok: true,
    packetSessionId,
    expectedSessionId,
    lookupSessionId: packetSessionId,
  };
}

function resolveIncomingExecutionSessionIds(input: {
  packet: TaskPacket;
  incomingSessionIdsByPacket: Map<string, string[]> | undefined;
  fallbackSessionId: string | undefined;
}): string[] {
  if (!input.incomingSessionIdsByPacket) {
    return input.fallbackSessionId ? [input.fallbackSessionId] : [];
  }

  return input.incomingSessionIdsByPacket.get(input.packet.packetId) ?? [];
}

function resolveIncomingSessionIdentity(input: {
  packetSessionId: string;
  expectedSessionId: string;
  incomingSessionIds: string[];
}): SessionIdentityResolution {
  if (input.incomingSessionIds.length === 0) {
    return {
      ok: false,
      reason: 'missing_session_identity',
      packetSessionId: input.packetSessionId,
      expectedSessionId: input.expectedSessionId,
    };
  }

  const hasExactMatch = input.incomingSessionIds.some(
    (incomingSessionId) =>
      incomingSessionId === input.packetSessionId &&
      incomingSessionId === input.expectedSessionId,
  );

  if (!hasExactMatch) {
    return {
      ok: false,
      reason: 'session_identity_mismatch',
      packetSessionId: input.packetSessionId,
      expectedSessionId: input.expectedSessionId,
    };
  }

  return {
    ok: true,
    packetSessionId: input.packetSessionId,
    expectedSessionId: input.expectedSessionId,
    lookupSessionId: input.packetSessionId,
  };
}

function createPacketBlockedLogEntry(
  packet: TaskPacket,
  actor: string,
  timestamp: string,
  reason: SessionIdentityBlockReason,
  details?: {
    packetSessionId?: string;
    expectedSessionId?: string;
    lookupSessionId?: string;
    incomingSessionIds?: string[];
  },
): ExecutionLogEntry {
  const packetSessionId = details?.packetSessionId ?? normalizeSessionId(packet.sessionId);
  const expectedSessionId = details?.expectedSessionId ?? normalizeSessionId(readPacketExpectedSessionId(packet));
  const lookupSessionId = details?.lookupSessionId;

  return {
    logId: `${packet.packetId}_log_reconcile_blocked_${timestamp}`,
    timestamp,
    correlationId: packet.correlationId,
    planId: packet.planId,
    packetId: packet.packetId,
    projectId: packet.projectId,
    sessionId: lookupSessionId ?? packet.sessionId,
    eventType: 'completion_evaluated',
    phase: 'reconciler',
    actor,
    result: 'info',
    message: `Packet remained waiting due to ${reason}.`,
    beforeStatus: packet.status,
    afterStatus: packet.status,
    metadata: {
      reason,
      localStub: false,
      packetSessionId: packetSessionId ?? null,
      expectedSessionId: expectedSessionId ?? null,
      lookupSessionId: lookupSessionId ?? null,
      incomingSessionIds: details?.incomingSessionIds ?? null,
    },
  };
}

function resolveRetryOutcome(packet: TaskPacket): {
  resolution: RetryResolution;
  toStatus: 'ready' | 'failed';
  reason: 'retry_requeued' | 'retry_exhausted';
} {
  const hasRetryRemaining = packet.attempt < readPacketMaxAttempts(packet);
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
  const packetIds = new Set(packets.map((packet) => packet.packetId));
  const incomingSessionIdsByPacket = scopeIncomingExecutionEventsByPacket(
    input.incomingExecutionEvents,
    packetIds,
  );
  const packetStatusBeforeById = new Map(packets.map((packet) => [packet.packetId, packet.status]));
  const decisions: ReconcileDecision[] = [];
  const logEntries: ExecutionLogEntry[] = [];

  let sessionManager: ReconcilerSessionManager | null = null;

  for (const packet of packets) {
    if (packet.status !== 'waiting') {
      continue;
    }

    const timestamp = input.timestamp ?? createTimestamp();
    const sessionIdentity = resolveRequiredPacketSessionIdentity(packet);
    if (!sessionIdentity.ok) {
      decisions.push({
        kind: 'packet_blocked',
        planId,
        packetId: packet.packetId,
        fromStatus: 'waiting',
        toStatus: 'waiting',
        reason: sessionIdentity.reason ?? 'missing_session_identity',
        correlationId: packet.correlationId,
      });
      logEntries.push(
        createPacketBlockedLogEntry(
          packet,
          actor,
          timestamp,
          sessionIdentity.reason ?? 'missing_session_identity',
          {
            packetSessionId: sessionIdentity.packetSessionId,
            expectedSessionId: sessionIdentity.expectedSessionId,
            lookupSessionId: sessionIdentity.lookupSessionId,
          },
        ),
      );
      continue;
    }

    const lookupSessionId = sessionIdentity.lookupSessionId;
    if (!lookupSessionId) {
      decisions.push({
        kind: 'packet_blocked',
        planId,
        packetId: packet.packetId,
        fromStatus: 'waiting',
        toStatus: 'waiting',
        reason: 'missing_session_identity',
        correlationId: packet.correlationId,
      });
      logEntries.push(
        createPacketBlockedLogEntry(
          packet,
          actor,
          timestamp,
          'missing_session_identity',
          {
            packetSessionId: sessionIdentity.packetSessionId,
            expectedSessionId: sessionIdentity.expectedSessionId,
            lookupSessionId,
          },
        ),
      );
      continue;
    }

    if (!sessionManager) {
      sessionManager = await createSessionManager();
    }

    const session = await sessionManager.get(lookupSessionId);

    if (!session) {
      decisions.push({
        kind: 'packet_blocked',
        planId,
        packetId: packet.packetId,
        fromStatus: 'waiting',
        toStatus: 'waiting',
        reason: 'ao_session_lookup_unresolved',
        correlationId: packet.correlationId,
      });
      logEntries.push(
        createPacketBlockedLogEntry(
          packet,
          actor,
          timestamp,
          'ao_session_lookup_unresolved',
          {
            packetSessionId: sessionIdentity.packetSessionId,
            expectedSessionId: sessionIdentity.expectedSessionId,
            lookupSessionId,
          },
        ),
      );
      continue;
    }

    const incomingSessionIds = resolveIncomingExecutionSessionIds({
      packet,
      incomingSessionIdsByPacket,
      fallbackSessionId: normalizeSessionId(session.id),
    });
    const incomingIdentity = resolveIncomingSessionIdentity({
      packetSessionId: sessionIdentity.packetSessionId ?? lookupSessionId,
      expectedSessionId: sessionIdentity.expectedSessionId ?? lookupSessionId,
      incomingSessionIds,
    });
    if (!incomingIdentity.ok) {
      decisions.push({
        kind: 'packet_blocked',
        planId,
        packetId: packet.packetId,
        fromStatus: 'waiting',
        toStatus: 'waiting',
        reason: incomingIdentity.reason ?? 'session_identity_mismatch',
        correlationId: packet.correlationId,
      });
      logEntries.push(
        createPacketBlockedLogEntry(
          packet,
          actor,
          timestamp,
          incomingIdentity.reason ?? 'session_identity_mismatch',
          {
            packetSessionId: incomingIdentity.packetSessionId,
            expectedSessionId: incomingIdentity.expectedSessionId,
            lookupSessionId,
            incomingSessionIds,
          },
        ),
      );
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
    const sessionId = lookupSessionId;
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
