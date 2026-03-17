import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPlanState, readTaskPackets } from '../state/file-state-store.js';
import type { ExecutionLogEntry } from '../types/execution-log.js';
import type {
  OperatorPlanState,
  PlanStatusCounts,
  PlanStatusInput,
  PlanStatusLatestReasons,
  PlanStatusOutcome,
  PlanStatusPacketRow,
  PlanStatusSummary,
} from '../types/plan-status.js';
import type { TaskPacket } from '../types/task-packet.js';

const WAITING_BLOCK_REASONS = new Set<string>([
  'missing_session_identity',
  'session_identity_mismatch',
  'ao_session_lookup_unresolved',
  'ao_session_needs_input',
  'stub_waiting_locally_completable',
]);

const GOVERNANCE_OR_DEPENDENCY_BLOCK_REASONS = new Set<string>([
  'skipped_dependency_not_satisfied',
  'skipped_risk_or_approval_block',
  'skipped_no_dispatch_capacity',
]);

function resolveControlLayerRoot(): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFilePath);
  return resolve(currentDir, '../..');
}

function countPackets(packets: TaskPacket[]): PlanStatusCounts {
  const counts: PlanStatusCounts = {
    totalPackets: packets.length,
    queued: 0,
    ready: 0,
    dispatching: 0,
    waiting: 0,
    retry: 0,
    blocked: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };

  for (const packet of packets) {
    counts[packet.status] += 1;
  }

  return counts;
}

function normalizeReason(entry: ExecutionLogEntry): string | null {
  const metadata = entry.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const reason = (metadata as Record<string, unknown>).reason;
    if (typeof reason === 'string' && reason.trim()) {
      return reason;
    }
  }

  if (entry.errorCode?.trim()) {
    return entry.errorCode;
  }

  return null;
}

function toOutcome(entry: ExecutionLogEntry): PlanStatusOutcome {
  return {
    timestamp: entry.timestamp,
    eventType: entry.eventType,
    result: entry.result,
    message: entry.message,
    packetId: entry.packetId,
    reason: normalizeReason(entry),
  };
}

function compareEntriesByTimestamp(
  left: ExecutionLogEntry,
  right: ExecutionLogEntry,
): number {
  if (left.timestamp === right.timestamp) {
    return left.logId.localeCompare(right.logId);
  }

  return left.timestamp.localeCompare(right.timestamp);
}

function pickLatestEntry(
  entries: ExecutionLogEntry[],
  predicate: (entry: ExecutionLogEntry) => boolean,
): ExecutionLogEntry | null {
  let latest: ExecutionLogEntry | null = null;

  for (const entry of entries) {
    if (!predicate(entry)) {
      continue;
    }

    if (!latest || compareEntriesByTimestamp(entry, latest) > 0) {
      latest = entry;
    }
  }

  return latest;
}

async function readExecutionEntriesForPlan(
  logFilePath: string,
  planId: string,
): Promise<ExecutionLogEntry[]> {
  let content: string;

  try {
    content = await readFile(logFilePath, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  const lines = content.split('\n');
  const entries: ExecutionLogEntry[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== 'object') {
      continue;
    }

    const candidate = parsed as Partial<ExecutionLogEntry>;
    if (candidate.planId !== planId || typeof candidate.timestamp !== 'string') {
      continue;
    }

    entries.push(candidate as ExecutionLogEntry);
  }

  return entries;
}

export function classifyOperatorPlanState(input: {
  planStatus: PlanStatusSummary['planStatus'];
  counts: PlanStatusCounts;
  blockingReasons: string[];
}): OperatorPlanState {
  const { planStatus, counts, blockingReasons } = input;
  const hasWaitingBlockReason = blockingReasons.some((reason) => WAITING_BLOCK_REASONS.has(reason));
  const hasGovernanceOrDependencyBlockReason = blockingReasons.some(
    (reason) => GOVERNANCE_OR_DEPENDENCY_BLOCK_REASONS.has(reason),
  );
  const hasActiveExecution = counts.dispatching > 0 || counts.retry > 0;
  const hasReadyPackets = counts.ready > 0;

  if (planStatus === 'completed' || (counts.totalPackets > 0 && counts.completed === counts.totalPackets)) {
    return 'completed';
  }

  if (planStatus === 'failed' || planStatus === 'escalated') {
    return 'failed_terminal';
  }

  if (hasActiveExecution) {
    return 'progressing';
  }

  if (hasReadyPackets && !hasGovernanceOrDependencyBlockReason) {
    return 'progressing';
  }

  const onlyTerminalOrWaitingOrBlocked =
    counts.queued === 0 &&
    counts.ready === 0 &&
    counts.dispatching === 0 &&
    counts.retry === 0;

  if (
    counts.failed > 0 &&
    counts.waiting === 0 &&
    counts.blocked === 0 &&
    onlyTerminalOrWaitingOrBlocked
  ) {
    return 'failed_terminal';
  }

  if (
    counts.waiting > 0 &&
    counts.queued === 0 &&
    counts.ready === 0 &&
    counts.dispatching === 0 &&
    counts.retry === 0
  ) {
    return 'blocked_waiting';
  }

  if (counts.waiting > 0 && hasWaitingBlockReason) {
    return 'blocked_waiting';
  }

  if (hasGovernanceOrDependencyBlockReason || counts.blocked > 0) {
    return 'blocked_governance_or_dependencies';
  }

  return 'idle_no_ready';
}

function deriveLatestReasons(input: {
  latestDispatchEntry: ExecutionLogEntry | null;
  latestReconcileEntry: ExecutionLogEntry | null;
  planBlockedReason?: string;
}): PlanStatusLatestReasons {
  return {
    dispatch: input.latestDispatchEntry ? normalizeReason(input.latestDispatchEntry) : null,
    reconcile: input.latestReconcileEntry ? normalizeReason(input.latestReconcileEntry) : null,
    plan: input.planBlockedReason?.trim() ? input.planBlockedReason : null,
  };
}

function buildOperatorSummary(input: {
  planId: string;
  planStatus: PlanStatusSummary['planStatus'];
  planCompleted: boolean;
  operatorState: OperatorPlanState;
  counts: PlanStatusCounts;
  latestDispatchOutcome: PlanStatusOutcome | null;
  latestReconcileOutcome: PlanStatusOutcome | null;
  latestStopReasons: PlanStatusLatestReasons;
  blockingReasons: string[];
}): PlanStatusSummary['operatorSummary'] {
  return {
    planId: input.planId,
    planStatus: input.planStatus,
    planCompleted: input.planCompleted,
    operatorState: input.operatorState,
    packetCounts: input.counts,
    latestDispatchOutcome: input.latestDispatchOutcome,
    latestReconcileOutcome: input.latestReconcileOutcome,
    latestStopReasons: input.latestStopReasons,
    blockingReasons: input.blockingReasons,
  };
}

function deriveBlockingReasons(input: {
  latestStopReasons: PlanStatusLatestReasons;
}): string[] {
  const reasons = new Set<string>();

  if (input.latestStopReasons.dispatch) {
    reasons.add(input.latestStopReasons.dispatch);
  }

  if (input.latestStopReasons.reconcile) {
    reasons.add(input.latestStopReasons.reconcile);
  }

  if (input.latestStopReasons.plan) {
    reasons.add(input.latestStopReasons.plan);
  }

  return [...reasons].sort();
}

function sortPackets(planPacketIds: string[], packets: TaskPacket[]): TaskPacket[] {
  const packetOrder = new Map(planPacketIds.map((packetId, index) => [packetId, index]));

  return [...packets].sort((left, right) => {
    const leftOrder = packetOrder.get(left.packetId);
    const rightOrder = packetOrder.get(right.packetId);

    if (leftOrder !== undefined && rightOrder !== undefined) {
      return leftOrder - rightOrder;
    }

    if (leftOrder !== undefined) {
      return -1;
    }

    if (rightOrder !== undefined) {
      return 1;
    }

    return left.packetId.localeCompare(right.packetId);
  });
}

function toPacketRows(packets: TaskPacket[]): PlanStatusPacketRow[] {
  return packets.map((packet) => ({
    packetId: packet.packetId,
    status: packet.status,
    dependencyCount: packet.dependencies.length,
    attempt: packet.attempt,
    action: packet.action,
  }));
}

export async function getPlanStatusSummary(
  input: PlanStatusInput,
): Promise<PlanStatusSummary> {
  const planId = input.planId.trim();
  if (!planId) {
    throw new Error('Plan id is required.');
  }

  const controlLayerRoot = resolveControlLayerRoot();
  const stateRoot = input.stateRoot
    ? resolve(process.cwd(), input.stateRoot)
    : resolve(controlLayerRoot, 'state');
  const planFilePath = resolve(stateRoot, 'plans', `${planId}.json`);
  const packetFilePath = resolve(stateRoot, 'packets', `${planId}.json`);
  const logFilePath = resolve(stateRoot, 'logs', 'execution.jsonl');

  await Promise.all([
    access(planFilePath).catch(() => {
      throw new Error(`Plan state not found for plan id "${planId}": ${planFilePath}`);
    }),
    access(packetFilePath).catch(() => {
      throw new Error(`Packet state not found for plan id "${planId}": ${packetFilePath}`);
    }),
  ]);

  const plan = await loadPlanState(planFilePath);
  if (!plan) {
    throw new Error(`Plan state not found for plan id "${planId}": ${planFilePath}`);
  }

  const packets = await readTaskPackets(packetFilePath);
  const sortedPackets = sortPackets(plan.packetIds, packets);
  const counts = countPackets(sortedPackets);
  const executionEntries = await readExecutionEntriesForPlan(logFilePath, planId);

  const latestDispatchEntry = pickLatestEntry(
    executionEntries,
    (entry) => entry.phase === 'dispatcher',
  );
  const latestReconcileEntry = pickLatestEntry(
    executionEntries,
    (entry) => entry.phase === 'reconciler',
  );

  const latestDispatchOutcome = latestDispatchEntry ? toOutcome(latestDispatchEntry) : null;
  const latestReconcileOutcome = latestReconcileEntry ? toOutcome(latestReconcileEntry) : null;
  const latestStopReasons = deriveLatestReasons({
    latestDispatchEntry,
    latestReconcileEntry,
    planBlockedReason: plan.blockedReason,
  });
  const blockingReasons = deriveBlockingReasons({
    latestStopReasons,
  });
  const operatorState = classifyOperatorPlanState({
    planStatus: plan.status,
    counts,
    blockingReasons,
  });

  return {
    planId,
    goal: plan.goal,
    planStatus: plan.status,
    planFilePath,
    packetFilePath,
    planCompleted: plan.status === 'completed',
    operatorState,
    counts,
    latestDispatchOutcome,
    latestReconcileOutcome,
    latestStopReasons,
    blockingReasons,
    operatorSummary: buildOperatorSummary({
      planId,
      planStatus: plan.status,
      planCompleted: plan.status === 'completed',
      operatorState,
      counts,
      latestDispatchOutcome,
      latestReconcileOutcome,
      latestStopReasons,
      blockingReasons,
    }),
    packets: toPacketRows(sortedPackets),
  };
}
