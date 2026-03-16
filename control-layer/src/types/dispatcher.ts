import type { TaskAction, TaskPacket, TaskStatus } from './task-packet.js';

export type DispatcherMode = 'stub' | 'ao-dry-run' | 'ao-exec';

export type DispatchDecisionReason =
  | 'dispatched_to_session'
  | 'dry_run_marked_only'
  | 'dry_run_simulated_dispatch'
  | 'skipped_not_ready'
  | 'skipped_already_has_session'
  | 'skipped_dependency_not_satisfied'
  | 'skipped_risk_or_approval_block'
  | 'skipped_no_dispatch_capacity';

export type DispatchDecisionOutcome = 'dispatched' | 'skipped';

export interface DispatcherInput {
  planId?: string;
  packetFile?: string;
  mode?: DispatcherMode;
  actor?: string;
  timestamp?: string;
  sessionId?: string;
  maxDispatches?: number;
}

export interface DispatchDecision {
  planId: string;
  packetId: string;
  action: TaskAction;
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
  mode: DispatcherMode;
  outcome: DispatchDecisionOutcome;
  reason: DispatchDecisionReason;
  correlationId: string;
}

export interface DryRunDispatchPayload {
  planId: string;
  packetId: string;
  correlationId: string;
  projectId: string;
  sessionId: string | null;
  expectedSessionId: string | null;
  action: TaskAction;
  payload: Record<string, unknown>;
  instruction: string | null;
  riskTier: TaskPacket['riskTier'];
  approvalState: TaskPacket['approvalState'];
  dependencies: string[];
  attempt: number;
  generatedAt: string;
  mode: 'ao-dry-run' | 'ao-exec';
}

export interface DispatchResult {
  planId: string;
  packetFilePath: string;
  evaluatedCount: number;
  dispatchedCount: number;
  skippedCount: number;
  dispatchedPacketIds: string[];
  decisions: DispatchDecision[];
  decisionCounts: Record<DispatchDecisionReason, number>;
  packets: TaskPacket[];
}
