import type { CycleProgressReason } from './cycle-stop-reason.js';
import type {
  OperatorPlanState,
  PlanStatusCounts,
  PlanStatusLatestReasons,
} from './plan-status.js';
import type { ReconcilerExecutionEvent } from './reconciler.js';

export interface SingleCycleRunnerInput {
  goal: string;
  incomingExecutionEvents?: ReconcilerExecutionEvent[];
}

export interface SingleCycleRunnerResult {
  planId: string;
  planFilePath: string;
  packetFilePath: string;
  dispatchedCount: number;
  completedCount: number;
  unlockedCount: number;
  planCompleted: boolean;
  stopReason: CycleProgressReason;
  operatorState: OperatorPlanState;
  packetCounts: PlanStatusCounts;
  latestStopReasons: PlanStatusLatestReasons;
  blockingReasons: string[];
}
