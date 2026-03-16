import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendExecutionLogEntry,
  createTimestamp,
} from '../logging/file-execution-log.js';
import { readTaskPackets, writeTaskPackets } from '../state/file-state-store.js';
import type { ExecutionLogEntry } from '../types/execution-log.js';
import type {
  DispatchDecision,
  DispatchDecisionReason,
  DispatcherInput,
  DispatchResult,
} from '../types/dispatcher.js';
import type { TaskPacket } from '../types/task-packet.js';

const DEFAULT_ACTOR = 'control-layer-dispatcher';

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

function areDependenciesSatisfied(packet: TaskPacket, packetsById: Map<string, TaskPacket>): boolean {
  return packet.dependencies.every((dependencyId) => {
    const dependency = packetsById.get(dependencyId);
    return dependency?.status === 'completed';
  });
}

function isDispatchable(packet: TaskPacket, packetsById: Map<string, TaskPacket>): boolean {
  if (packet.status === 'ready') {
    return true;
  }

  if (packet.status === 'queued') {
    return areDependenciesSatisfied(packet, packetsById);
  }

  return false;
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

function createDispatchLogEntries(
  packet: TaskPacket,
  actor: string,
  timestamp: string,
  decision: DispatchDecision,
): ExecutionLogEntry[] {
  const attempt = packet.attempt + 1;
  const statusChangePrefix = `${packet.packetId}_log_status_${timestamp}_${attempt}`;

  const entries: ExecutionLogEntry[] = [];

  if (decision.fromStatus === 'queued') {
    entries.push({
      logId: `${statusChangePrefix}_ready`,
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
        mode: decision.mode,
        reason: decision.reason,
        localStub: true,
      },
    });
  }

  entries.push({
    logId: `${statusChangePrefix}_dispatching`,
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
    message: 'Packet moved to dispatching by local dispatcher stub.',
    beforeStatus: decision.fromStatus === 'queued' ? 'ready' : decision.fromStatus,
    afterStatus: 'dispatching',
    metadata: {
      mode: decision.mode,
      reason: decision.reason,
      localStub: true,
    },
  });

  entries.push({
    logId: `${packet.packetId}_log_dispatch_started_${timestamp}_${attempt}`,
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
    message: 'Stub dispatch started (no AO call).',
    attempt,
    metadata: {
      action: packet.action,
      mode: decision.mode,
      localStub: true,
    },
  });

  entries.push({
    logId: `${statusChangePrefix}_waiting`,
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
    message: 'Packet moved from dispatching to waiting by local dispatcher stub.',
    beforeStatus: 'dispatching',
    afterStatus: 'waiting',
    metadata: {
      mode: decision.mode,
      localStub: true,
    },
  });

  entries.push({
    logId: `${packet.packetId}_log_dispatch_succeeded_${timestamp}_${attempt}`,
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
    message: 'Stub dispatch succeeded; packet set to waiting.',
    attempt,
    metadata: {
      action: packet.action,
      mode: decision.mode,
      localStub: true,
    },
  });

  return entries;
}

function requirePlanId(planId: string | undefined, packetFile: string): string {
  if (planId) {
    return planId;
  }

  throw new Error(`Could not infer plan id for packet file: ${packetFile}`);
}

export async function runDispatcherStub(input: DispatcherInput): Promise<DispatchResult> {
  if (!input.planId && !input.packetFile) {
    throw new Error('Either planId or packetFile must be provided.');
  }

  const actor = input.actor ?? DEFAULT_ACTOR;
  const mode = input.mode ?? 'stub';
  const timestamp = input.timestamp ?? createTimestamp();

  const { packetFilePath, logFilePath } = resolveStatePaths(input);
  const packets = await readTaskPackets(packetFilePath);

  if (packets.length === 0) {
    const planId = requirePlanId(input.planId, packetFilePath);
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

  const packetsById = new Map(packets.map((packet) => [packet.packetId, packet]));
  const decisions: DispatchDecision[] = [];
  const decisionCounts = createDecisionCounts();
  const logEntries: ExecutionLogEntry[] = [];

  for (const packet of packets) {
    if (!isDispatchable(packet, packetsById)) {
      continue;
    }

    const decision: DispatchDecision = {
      planId,
      packetId: packet.packetId,
      action: packet.action,
      fromStatus: packet.status,
      toStatus: 'waiting',
      mode,
      outcome: 'dispatched',
      reason: 'dispatched_to_session',
      correlationId: packet.correlationId,
    };

    const packetTimestamp = createTimestamp();
    if (packet.status === 'queued') {
      packet.status = 'ready';
    }
    packet.status = 'dispatching';
    if (!packet.startedAt) {
      packet.startedAt = packetTimestamp;
    }
    packet.updatedAt = packetTimestamp;

    packet.status = 'waiting';
    packet.updatedAt = packetTimestamp;

    decisions.push(decision);
    decisionCounts[decision.reason] += 1;
    logEntries.push(...createDispatchLogEntries(packet, actor, timestamp, decision));
  }

  if (decisions.length > 0) {
    await writeTaskPackets(packetFilePath, packets);
    for (const logEntry of logEntries) {
      await appendExecutionLogEntry(logFilePath, logEntry);
    }
  }

  return {
    planId,
    packetFilePath,
    evaluatedCount: packets.length,
    dispatchedCount: decisions.length,
    skippedCount: packets.length - decisions.length,
    dispatchedPacketIds: decisions.map((decision) => decision.packetId),
    decisions,
    decisionCounts,
    packets,
  };
}
