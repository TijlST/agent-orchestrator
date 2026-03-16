import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendExecutionLogEntry,
  createTimestamp,
} from '../logging/file-execution-log.js';
import {
  ensureDirectoryExists,
  readTaskPackets,
  writeTaskPackets,
} from '../state/file-state-store.js';
import type { ExecutionLogEntry } from '../types/execution-log.js';
import type {
  DispatchDecision,
  DispatchDecisionReason,
  DispatchResult,
  DispatcherInput,
  DryRunDispatchPayload,
} from '../types/dispatcher.js';
import type { TaskPacket } from '../types/task-packet.js';
import { loadConfig } from '../../../packages/core/dist/index.js';
import type { OpenCodeSessionManager } from '../../../packages/core/dist/index.js';
import { getSessionManager } from '../../../packages/cli/dist/lib/create-session-manager.js';

const DEFAULT_ACTOR = 'control-layer-dispatcher';
const FAILURE_CODE = 'ao_exec_dispatch_failed';

interface AoExecDispatcherDeps {
  createSessionManager?: () => Promise<OpenCodeSessionManager>;
}

function resolveControlLayerRoot(): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFilePath);
  return resolve(currentDir, '../..');
}

function resolveStatePaths(input: DispatcherInput): {
  packetFilePath: string;
  logFilePath: string;
} {
  const controlLayerRoot = resolveControlLayerRoot();
  const stateRoot = resolve(controlLayerRoot, 'state');
  const packetFilePath = input.packetFile
    ? resolve(process.cwd(), input.packetFile)
    : resolve(stateRoot, 'packets', `${input.planId}.json`);

  return {
    packetFilePath,
    logFilePath: resolve(stateRoot, 'logs', 'execution.jsonl'),
  };
}

function resolveDispatchFilePath(planId: string): string {
  return resolve(resolveControlLayerRoot(), 'state', 'dispatches', `${planId}.json`);
}

function areDependenciesSatisfied(packet: TaskPacket, packetsById: Map<string, TaskPacket>): boolean {
  return packet.dependencies.every((dependencyId) => {
    const dependency = packetsById.get(dependencyId);
    return dependency?.status === 'completed';
  });
}

function canDispatchInLocalSafeMode(packet: TaskPacket): boolean {
  const approvalAllowed = packet.approvalState === 'not_required' || packet.approvalState === 'approved';
  return packet.riskTier === 'read_only' && approvalAllowed;
}

function resolveDispatchCapacity(input: DispatcherInput): number | null {
  if (typeof input.maxDispatches === 'number' && Number.isFinite(input.maxDispatches)) {
    return Math.max(0, Math.floor(input.maxDispatches));
  }

  const rawCapacity = process.env.CONTROL_LAYER_DISPATCH_MAX;
  if (!rawCapacity) {
    return null;
  }

  const parsed = Number.parseInt(rawCapacity, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function createDecisionCounts(): Record<DispatchDecisionReason, number> {
  return {
    dispatched_to_session: 0,
    dry_run_marked_only: 0,
    dry_run_simulated_dispatch: 0,
    skipped_not_ready: 0,
    skipped_already_has_session: 0,
    skipped_dependency_not_satisfied: 0,
    skipped_risk_or_approval_block: 0,
    skipped_no_dispatch_capacity: 0,
  };
}

function requirePlanId(planId: string | undefined, packetFile: string): string {
  if (planId) {
    return planId;
  }

  throw new Error(`Could not infer plan id for packet file: ${packetFile}`);
}

function extractInstruction(payload: Record<string, unknown>): string | null {
  const instruction = payload.instruction;
  if (typeof instruction !== 'string') {
    return null;
  }

  const trimmed = instruction.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toExecPayload(packet: TaskPacket, generatedAt: string): DryRunDispatchPayload {
  return {
    planId: packet.planId,
    packetId: packet.packetId,
    correlationId: packet.correlationId,
    projectId: packet.projectId,
    sessionId: packet.sessionId ?? null,
    expectedSessionId: packet.completionCriteria.expectedSessionId ?? null,
    action: packet.action,
    payload: packet.payload,
    instruction: extractInstruction(packet.payload),
    riskTier: packet.riskTier,
    approvalState: packet.approvalState,
    dependencies: [...packet.dependencies],
    attempt: packet.attempt + 1,
    generatedAt,
    mode: 'ao-exec',
  };
}

async function createAoExecSessionManager(): Promise<OpenCodeSessionManager> {
  const config = loadConfig();
  return getSessionManager(config);
}

function resolvePacketSessionId(packet: TaskPacket, input: DispatcherInput): string | null {
  const explicit = input.sessionId?.trim();
  if (explicit) {
    return explicit;
  }

  const existing = packet.sessionId?.trim();
  if (existing) {
    return existing;
  }

  return null;
}

function createQueuedToReadyLogEntry(
  packet: TaskPacket,
  actor: string,
  timestamp: string,
  reason: DispatchDecisionReason,
): ExecutionLogEntry {
  return {
    logId: `${packet.packetId}_log_status_${timestamp}_${packet.attempt + 1}_ready`,
    timestamp,
    correlationId: packet.correlationId,
    planId: packet.planId,
    packetId: packet.packetId,
    projectId: packet.projectId,
    sessionId: packet.sessionId,
    eventType: 'packet_status_changed',
    phase: 'dispatcher',
    actor,
    result: 'info',
    message: 'Packet moved from queued to ready (dependencies satisfied).',
    beforeStatus: 'queued',
    afterStatus: 'ready',
    metadata: {
      mode: 'ao-exec',
      reason,
    },
  };
}

function createDispatchingLogEntry(
  packet: TaskPacket,
  actor: string,
  timestamp: string,
  fromStatus: TaskPacket['status'],
  reason: DispatchDecisionReason,
): ExecutionLogEntry {
  return {
    logId: `${packet.packetId}_log_status_${timestamp}_${packet.attempt + 1}_dispatching`,
    timestamp,
    correlationId: packet.correlationId,
    planId: packet.planId,
    packetId: packet.packetId,
    projectId: packet.projectId,
    sessionId: packet.sessionId,
    eventType: 'packet_status_changed',
    phase: 'dispatcher',
    actor,
    result: 'info',
    message: 'Packet moved to dispatching by AO exec dispatcher.',
    beforeStatus: fromStatus,
    afterStatus: 'dispatching',
    metadata: {
      mode: 'ao-exec',
      reason,
    },
  };
}

function createDispatchStartedLogEntry(
  packet: TaskPacket,
  actor: string,
  timestamp: string,
): ExecutionLogEntry {
  return {
    logId: `${packet.packetId}_log_dispatch_started_${timestamp}_${packet.attempt + 1}`,
    timestamp,
    correlationId: packet.correlationId,
    planId: packet.planId,
    packetId: packet.packetId,
    projectId: packet.projectId,
    sessionId: packet.sessionId,
    eventType: 'dispatch_started',
    phase: 'dispatcher',
    actor,
    result: 'info',
    message: 'AO exec dispatch started.',
    attempt: packet.attempt + 1,
    metadata: {
      action: packet.action,
      mode: 'ao-exec',
    },
  };
}

function createSessionSpawnedLogEntry(
  packet: TaskPacket,
  actor: string,
  timestamp: string,
): ExecutionLogEntry {
  return {
    logId: `${packet.packetId}_log_session_spawned_${timestamp}_${packet.attempt + 1}`,
    timestamp,
    correlationId: packet.correlationId,
    planId: packet.planId,
    packetId: packet.packetId,
    projectId: packet.projectId,
    sessionId: packet.sessionId,
    eventType: 'session_spawned',
    phase: 'dispatcher',
    actor,
    result: 'info',
    message: 'AO exec dispatcher spawned new session',
    attempt: packet.attempt + 1,
    metadata: {
      action: packet.action,
      mode: 'ao-exec',
    },
  };
}

function createDispatchSucceededLogEntry(
  packet: TaskPacket,
  actor: string,
  timestamp: string,
): ExecutionLogEntry {
  return {
    logId: `${packet.packetId}_log_dispatch_succeeded_${timestamp}_${packet.attempt + 1}`,
    timestamp,
    correlationId: packet.correlationId,
    planId: packet.planId,
    packetId: packet.packetId,
    projectId: packet.projectId,
    sessionId: packet.sessionId,
    eventType: 'dispatch_succeeded',
    phase: 'dispatcher',
    actor,
    result: 'success',
    message: 'AO exec dispatch succeeded; packet set to waiting.',
    attempt: packet.attempt + 1,
    metadata: {
      action: packet.action,
      mode: 'ao-exec',
    },
  };
}

function createWaitingStatusLogEntry(
  packet: TaskPacket,
  actor: string,
  timestamp: string,
): ExecutionLogEntry {
  return {
    logId: `${packet.packetId}_log_status_${timestamp}_${packet.attempt + 1}_waiting`,
    timestamp,
    correlationId: packet.correlationId,
    planId: packet.planId,
    packetId: packet.packetId,
    projectId: packet.projectId,
    sessionId: packet.sessionId,
    eventType: 'packet_status_changed',
    phase: 'dispatcher',
    actor,
    result: 'info',
    message: 'Packet moved from dispatching to waiting by AO exec dispatcher.',
    beforeStatus: 'dispatching',
    afterStatus: 'waiting',
    metadata: {
      mode: 'ao-exec',
    },
  };
}

function createDispatchFailedLogEntry(
  packet: TaskPacket,
  actor: string,
  timestamp: string,
  message: string,
): ExecutionLogEntry {
  return {
    logId: `${packet.packetId}_log_dispatch_failed_${timestamp}_${packet.attempt + 1}`,
    timestamp,
    correlationId: packet.correlationId,
    planId: packet.planId,
    packetId: packet.packetId,
    projectId: packet.projectId,
    sessionId: packet.sessionId,
    eventType: 'dispatch_failed',
    phase: 'dispatcher',
    actor,
    result: 'error',
    message: `AO exec dispatch failed: ${message}`,
    attempt: packet.attempt + 1,
    errorCode: FAILURE_CODE,
    errorMessage: message,
    metadata: {
      action: packet.action,
      mode: 'ao-exec',
    },
  };
}

export async function runDispatcherAoExec(
  input: DispatcherInput,
  deps: AoExecDispatcherDeps = {},
): Promise<DispatchResult> {
  if (!input.planId && !input.packetFile) {
    throw new Error('Either planId or packetFile must be provided.');
  }

  const actor = input.actor ?? DEFAULT_ACTOR;
  const timestamp = input.timestamp ?? createTimestamp();
  const { packetFilePath, logFilePath } = resolveStatePaths(input);
  const packets = await readTaskPackets(packetFilePath);

  if (packets.length === 0) {
    const planId = requirePlanId(input.planId, packetFilePath);
    const dispatchFilePath = resolveDispatchFilePath(planId);
    await ensureDirectoryExists(dirname(dispatchFilePath));
    await writeFile(dispatchFilePath, '[]\n', 'utf8');
    return {
      planId,
      packetFilePath,
      evaluatedCount: 0,
      dispatchedCount: 0,
      skippedCount: 0,
      dispatchedPacketIds: [],
      decisions: [],
      decisionCounts: createDecisionCounts(),
      packets,
    };
  }

  const planId = input.planId ?? packets[0]?.planId;
  if (!planId) {
    throw new Error(`Packet file does not contain plan id: ${packetFilePath}`);
  }

  const dispatchFilePath = resolveDispatchFilePath(planId);
  const packetsById = new Map(packets.map((packet) => [packet.packetId, packet]));
  const decisions: DispatchDecision[] = [];
  const decisionCounts = createDecisionCounts();
  const payloads: DryRunDispatchPayload[] = [];
  const logEntries: ExecutionLogEntry[] = [];
  const dispatchCapacity = resolveDispatchCapacity(input);
  let dispatchedCount = 0;
  let sessionManager: OpenCodeSessionManager | null = null;

  for (const packet of packets) {
    let skippedReason: DispatchDecisionReason | null = null;
    if (packet.status === 'queued' && !areDependenciesSatisfied(packet, packetsById)) {
      skippedReason = 'skipped_dependency_not_satisfied';
    } else if (packet.status !== 'queued' && packet.status !== 'ready') {
      skippedReason = 'skipped_not_ready';
    } else if (!canDispatchInLocalSafeMode(packet)) {
      skippedReason = 'skipped_risk_or_approval_block';
    } else if (dispatchCapacity !== null && dispatchedCount >= dispatchCapacity) {
      skippedReason = 'skipped_no_dispatch_capacity';
    }

    if (skippedReason) {
      const decision: DispatchDecision = {
        planId,
        packetId: packet.packetId,
        action: packet.action,
        fromStatus: packet.status,
        toStatus: packet.status,
        mode: 'ao-exec',
        outcome: 'skipped',
        reason: skippedReason,
        correlationId: packet.correlationId,
      };
      decisions.push(decision);
      decisionCounts[skippedReason] += 1;
      continue;
    }

    const reason: DispatchDecisionReason = 'dispatched_to_session';
    const fromStatus = packet.status;
    if (packet.status === 'queued') {
      packet.status = 'ready';
      logEntries.push(createQueuedToReadyLogEntry(packet, actor, timestamp, reason));
    }

    packet.status = 'dispatching';
    if (!packet.startedAt) {
      packet.startedAt = timestamp;
    }
    packet.updatedAt = timestamp;
    logEntries.push(createDispatchingLogEntry(packet, actor, timestamp, 'ready', reason));
    logEntries.push(createDispatchStartedLogEntry(packet, actor, timestamp));

    try {
      const instruction = extractInstruction(packet.payload);
      const resolvedSessionId = resolvePacketSessionId(packet, input);

      if (resolvedSessionId) {
        packet.sessionId = resolvedSessionId;
        packet.completionCriteria.expectedSessionId = resolvedSessionId;
      }

      if (packet.action !== 'send_instruction') {
        throw new Error(`Unsupported action "${packet.action}" for ao-exec mode.`);
      }
      if (!instruction) {
        throw new Error('Missing required packet.payload.instruction for ao-exec dispatch.');
      }

      if (!sessionManager) {
        sessionManager = deps.createSessionManager
          ? await deps.createSessionManager()
          : await createAoExecSessionManager();
      }

      if (!packet.sessionId?.trim()) {
        const spawnConfig = {
          sessionId: packet.packetId,
          projectId: packet.projectId,
          prompt: instruction,
        };
        const session = await sessionManager.spawn(spawnConfig);
        const spawnedSessionId =
          (session as { sessionId?: unknown }).sessionId ?? (session as { id?: unknown }).id;

        if (typeof spawnedSessionId !== 'string' || spawnedSessionId.trim().length === 0) {
          throw new Error('Spawned AO session did not return a valid session id.');
        }

        packet.sessionId = spawnedSessionId;
        packet.completionCriteria.expectedSessionId = spawnedSessionId;
        logEntries.push(createSessionSpawnedLogEntry(packet, actor, timestamp));
      } else {
        await sessionManager.send(packet.sessionId, instruction);
      }

      packet.status = 'waiting';
      packet.lastErrorCode = undefined;
      packet.lastErrorMessage = undefined;
      packet.updatedAt = timestamp;

      const decision: DispatchDecision = {
        planId,
        packetId: packet.packetId,
        action: packet.action,
        fromStatus,
        outcome: 'dispatched',
        toStatus: 'waiting',
        mode: 'ao-exec',
        reason,
        correlationId: packet.correlationId,
      };

      decisions.push(decision);
      decisionCounts[decision.reason] += 1;
      dispatchedCount += 1;
      payloads.push(toExecPayload(packet, timestamp));
      logEntries.push(createWaitingStatusLogEntry(packet, actor, timestamp));
      logEntries.push(createDispatchSucceededLogEntry(packet, actor, timestamp));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      packet.lastErrorCode = FAILURE_CODE;
      packet.lastErrorMessage = message;
      packet.status = 'ready';
      packet.updatedAt = timestamp;
      logEntries.push(createDispatchFailedLogEntry(packet, actor, timestamp, message));
    }
  }

  await writeTaskPackets(packetFilePath, packets);
  await ensureDirectoryExists(dirname(dispatchFilePath));
  await writeFile(dispatchFilePath, `${JSON.stringify(payloads, null, 2)}\n`, 'utf8');

  for (const entry of logEntries) {
    await appendExecutionLogEntry(logFilePath, entry);
  }

  return {
    planId,
    packetFilePath,
    evaluatedCount: packets.length,
    dispatchedCount: decisions.filter((decision) => decision.outcome === 'dispatched').length,
    skippedCount: decisions.filter((decision) => decision.outcome === 'skipped').length,
    dispatchedPacketIds: decisions
      .filter((decision) => decision.outcome === 'dispatched')
      .map((decision) => decision.packetId),
    decisions,
    decisionCounts,
    packets,
  };
}
