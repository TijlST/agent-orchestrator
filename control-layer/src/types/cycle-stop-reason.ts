export type CycleProgressReason =
  | 'no_ready_packets'
  | 'dispatched_packets'
  | 'reconciled_progress'
  | 'plan_completed';

export type RunUntilBlockedStopReason =
  | 'blocked_waiting'
  | 'no_ready_packets'
  | 'plan_completed'
  | 'max_iterations_reached';
