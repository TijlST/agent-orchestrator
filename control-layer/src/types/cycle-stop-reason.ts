export type CycleProgressReason =
  | 'no_ready_packets'
  | 'blocked_waiting'
  | 'blocked_governance_or_dependencies'
  | 'dispatched_packets'
  | 'reconciled_progress'
  | 'failed_terminal'
  | 'plan_completed';

export type RunUntilBlockedStopReason =
  | 'blocked_waiting'
  | 'blocked_governance_or_dependencies'
  | 'no_ready_packets'
  | 'failed_terminal'
  | 'plan_completed'
  | 'max_iterations_reached';
