import type {
  CycleProgressReason,
  RunUntilBlockedStopReason,
} from './cycle-stop-reason.js';
import type {
  OperatorPlanState,
  PlanStatusCounts,
  PlanStatusLatestReasons,
} from './plan-status.js';

export interface RunUntilBlockedInput {
  planId: string;
  maxCycles?: number;
}

export interface RunUntilBlockedResult {
  planId: string;
  planFilePath: string;
  packetFilePath: string;
  cyclesExecuted: number;
  totalDispatched: number;
  totalCompleted: number;
  totalUnlocked: number;
  remainingQueued: number;
  remainingReady: number;
  remainingWaiting: number;
  stopReason: RunUntilBlockedStopReason;
  lastCycleStopReason: CycleProgressReason | null;
  planCompleted: boolean;
  operatorState: OperatorPlanState;
  packetCounts: PlanStatusCounts;
  latestStopReasons: PlanStatusLatestReasons;
}
