import type { CycleProgressReason } from './cycle-stop-reason.js';
import type {
  OperatorPlanState,
  PlanStatusCounts,
  PlanStatusLatestReasons,
} from './plan-status.js';
import type { ReconcilerExecutionEvent } from './reconciler.js';

export interface PlanCycleRunnerInput {
  planId: string;
  incomingExecutionEvents?: ReconcilerExecutionEvent[];
}

export interface PlanCycleRunnerResult {
  planId: string;
  planFilePath: string;
  packetFilePath: string;
  readyBeforeDispatch: number;
  dispatchedCount: number;
  completedCount: number;
  unlockedCount: number;
  remainingQueued: number;
  remainingReady: number;
  remainingWaiting: number;
  planCompleted: boolean;
  stopReason: CycleProgressReason;
  operatorState: OperatorPlanState;
  packetCounts: PlanStatusCounts;
  latestStopReasons: PlanStatusLatestReasons;
  blockingReasons: string[];
}
