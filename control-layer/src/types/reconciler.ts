import type { PlanStatus } from './plan-state.js';
import type { TaskStatus } from './task-packet.js';

export interface ReconcilerInput {
  planId?: string;
  packetFile?: string;
  actor?: string;
  timestamp?: string;
}

export interface ReconcileDecision {
  kind:
    | 'packet_completed'
    | 'packet_unlocked'
    | 'packet_blocked'
    | 'packet_requeued'
    | 'packet_failed'
    | 'plan_completed';
  planId: string;
  packetId?: string;
  fromStatus?: TaskStatus | PlanStatus;
  toStatus?: TaskStatus | PlanStatus;
  reason:
    | 'stub_waiting_locally_completable'
    | 'ao_session_terminal'
    | 'ao_session_needs_input'
    | 'ao_session_terminal_without_completion_marker'
    | 'retry_requeued'
    | 'retry_exhausted'
    | 'missing_session_identity'
    | 'session_identity_mismatch'
    | 'ao_session_lookup_unresolved'
    | 'dependencies_satisfied'
    | 'all_packets_completed';
  correlationId?: string;
}

export interface ReconcileResult {
  planId: string;
  planFilePath: string;
  packetFilePath: string;
  evaluatedPacketCount: number;
  completedCount: number;
  requeuedCount: number;
  failedCount: number;
  unlockedCount: number;
  planCompleted: boolean;
  summary: {
    completedPackets: number;
    requeuedPackets: number;
    failedPackets: number;
    unlockedPackets: number;
    planCompleted: boolean;
  };
  decisions: ReconcileDecision[];
}
