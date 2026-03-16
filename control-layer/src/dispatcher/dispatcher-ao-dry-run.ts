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

function requirePlanId(planId: string | undefined, packetFile: string): string {
  if (planId) {
    return planId;
  }

  throw new Error(`Could not infer plan id for packet file: ${packetFile}`);
}

function extractInstruction(payload: Record<string, unknown>): string | null {
  const directInstruction = payload.instruction;
  if (typeof directInstruction === 'string') {
    return directInstruction;
  }

  const metadata = payload.metadata;
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return null;
  }

  const instruction = (metadata as Record<string, unknown>).instruction;
  return typeof instruction === 'string' ? instruction : null;
}

function createDryRunLogEntries(
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
        mode: 'ao-dry-run',
        reason: decision.reason,
        localStub: true,
        dryRun: true,
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
    message: 'Packet moved to dispatching by AO dry-run dispatcher.',
    beforeStatus: decision.fromStatus === 'queued' ? 'ready' : decision.fromStatus,
    afterStatus: 'dispatching',
    metadata: {
      mode: 'ao-dry-run',
      reason: decision.reason,
      localStub: true,
      dryRun: true,
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
    message: 'AO dry-run dispatch prepared (no external execution).',
    attempt,
    metadata: {
      action: packet.action,
      mode: 'ao-dry-run',
      localStub: true,
      dryRun: true,
    },
  });

  entries.push({
    logId: `${packet.packetId}_log_dispatch_payload_prepared_${timestamp}_${attempt}`,
    timestamp,
    correlationId: packet.correlationId,
    planId: packet.planId,
    packetId: packet.packetId,
    projectId: packet.projectId,
    sessionId: packet.sessionId,
    eventType: 'reconcile_snapshot',
    phase: 'dispatcher',
    actor,
    result: 'info',
    message: 'AO dry-run payload prepared and written to state artifact.',
    attempt,
    metadata: {
      action: packet.action,
      mode: 'ao-dry-run',
      localStub: true,
      dryRun: true,
    },
  });

  return entries;
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

function toDryRunPayload(packet: TaskPacket, generatedAt: string): DryRunDispatchPayload {
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
    mode: 'ao-dry-run',
  };
}

export async function runDispatcherAoDryRun(
  input: DispatcherInput,
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

  const resolvedDispatchFilePath = resolveDispatchFilePath(planId);

  const packetsById = new Map(packets.map((packet) => [packet.packetId, packet]));
  const decisions: DispatchDecision[] = [];
  const decisionCounts = createDecisionCounts();
  const payloads: DryRunDispatchPayload[] = [];
  const logEntries: ExecutionLogEntry[] = [];
  const dispatchCapacity = resolveDispatchCapacity(input);
  let dispatchedCount = 0;

  for (const packet of packets) {
    let reason: DispatchDecisionReason;
    let outcome: DispatchDecision['outcome'] = 'skipped';
    let toStatus: TaskPacket['status'] = packet.status;

    if (packet.status === 'queued' && !areDependenciesSatisfied(packet, packetsById)) {
      reason = 'skipped_dependency_not_satisfied';
    } else if (packet.status !== 'queued' && packet.status !== 'ready') {
      reason = 'skipped_not_ready';
    } else if (packet.sessionId?.trim()) {
      reason = 'skipped_already_has_session';
    } else if (!canDispatchInLocalSafeMode(packet)) {
      reason = 'skipped_risk_or_approval_block';
    } else if (dispatchCapacity !== null && dispatchedCount >= dispatchCapacity) {
      reason = 'skipped_no_dispatch_capacity';
    } else {
      outcome = 'dispatched';
      reason = packet.action === 'send_instruction'
        ? 'dry_run_simulated_dispatch'
        : 'dry_run_marked_only';
      toStatus = 'dispatching';
    }

    const decision: DispatchDecision = {
      planId,
      packetId: packet.packetId,
      action: packet.action,
      fromStatus: packet.status,
      toStatus,
      mode: 'ao-dry-run',
      outcome,
      reason,
      correlationId: packet.correlationId,
    };

    decisions.push(decision);
    decisionCounts[reason] += 1;

    if (outcome === 'dispatched') {
      const resolvedSessionId = resolvePacketSessionId(packet, input);
      if (resolvedSessionId) {
        packet.sessionId = resolvedSessionId;
        packet.completionCriteria.expectedSessionId = resolvedSessionId;
      }

      const packetTimestamp = createTimestamp();
      if (packet.status === 'queued') {
        packet.status = 'ready';
      }
      packet.status = 'dispatching';
      if (!packet.startedAt) {
        packet.startedAt = packetTimestamp;
      }
      packet.updatedAt = packetTimestamp;

      dispatchedCount += 1;
      payloads.push(toDryRunPayload(packet, packetTimestamp));
      logEntries.push(...createDryRunLogEntries(packet, actor, timestamp, decision));
    }
  }

  await writeTaskPackets(packetFilePath, packets);
  await ensureDirectoryExists(dirname(resolvedDispatchFilePath));
  await writeFile(
    resolvedDispatchFilePath,
    `${JSON.stringify(payloads, null, 2)}\n`,
    'utf8',
  );

  for (const logEntry of logEntries) {
    await appendExecutionLogEntry(logFilePath, logEntry);
  }

  return {
    planId,
    packetFilePath,
    evaluatedCount: packets.length,
    dispatchedCount,
    skippedCount: packets.length - dispatchedCount,
    dispatchedPacketIds: decisions
      .filter((decision) => decision.outcome === 'dispatched')
      .map((decision) => decision.packetId),
    decisions,
    decisionCounts,
    packets,
  };
}
