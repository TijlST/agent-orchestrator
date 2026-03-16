import type { PlanStatus as PlanLifecycleStatus } from './plan-state.js';
import type {
  ExecutionEventType,
  ExecutionResult,
} from './execution-log.js';
import type { TaskAction, TaskStatus } from './task-packet.js';

export interface PlanStatusPacketRow {
  packetId: string;
  status: TaskStatus;
  dependencyCount: number;
  attempt: number;
  action: TaskAction;
}

export interface PlanStatusCounts {
  totalPackets: number;
  queued: number;
  ready: number;
  dispatching: number;
  waiting: number;
  retry: number;
  blocked: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export type OperatorPlanState =
  | 'completed'
  | 'progressing'
  | 'blocked_waiting'
  | 'failed_terminal'
  | 'idle_no_ready';

export interface PlanStatusOutcome {
  timestamp: string;
  eventType: ExecutionEventType;
  result: ExecutionResult;
  message: string;
  packetId?: string;
  reason: string | null;
}

export interface PlanStatusLatestReasons {
  dispatch: string | null;
  reconcile: string | null;
  plan: string | null;
}

export interface PlanStatusOperatorSummary {
  planId: string;
  planStatus: PlanLifecycleStatus;
  planCompleted: boolean;
  operatorState: OperatorPlanState;
  packetCounts: PlanStatusCounts;
  latestDispatchOutcome: PlanStatusOutcome | null;
  latestReconcileOutcome: PlanStatusOutcome | null;
  latestStopReasons: PlanStatusLatestReasons;
}

export interface PlanStatusSummary {
  planId: string;
  goal?: string;
  planStatus: PlanLifecycleStatus;
  planFilePath: string;
  packetFilePath: string;
  planCompleted: boolean;
  operatorState: OperatorPlanState;
  counts: PlanStatusCounts;
  latestDispatchOutcome: PlanStatusOutcome | null;
  latestReconcileOutcome: PlanStatusOutcome | null;
  latestStopReasons: PlanStatusLatestReasons;
  operatorSummary: PlanStatusOperatorSummary;
  packets: PlanStatusPacketRow[];
}

export interface PlanStatusInput {
  planId: string;
  stateRoot?: string;
}
