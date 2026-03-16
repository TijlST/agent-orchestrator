# Control-Layer Invariants (Local-Safe)

This document captures the behavior contract for the current local-safe control-layer loop.

## Reconciler invariants

- Completion-marker gate: a waiting packet with a session is marked `completed` only when its completion marker is detected repeatedly (not just once).
- Dependency unlock gate: a queued packet is unlocked to `ready` only when every dependency packet is in `completed` status.
- Failed dependency gate: dependencies in `failed` (or any non-`completed`) status do not unlock dependents.
- Waiting retry governance for blocked/errored/terminal-without-marker sessions:
  - Retry remaining (`attempt < maxAttempts`): packet moves `waiting -> ready`, `attempt` increments, and reason is `retry_requeued`.
  - Retry exhausted (`attempt >= maxAttempts`): packet moves `waiting -> failed` with reason `retry_exhausted`.

## Operator state invariants (`operatorState`)

- `completed`: plan is complete (plan status `completed` or all packets completed).
- `progressing`: there is active runnable work (`ready`, `dispatching`, or `retry` packets).
- `blocked_waiting`: only waiting work remains (no queued/ready/dispatching/retry packets).
- `failed_terminal`: plan is terminally failed/escalated, or only terminally failed work remains.
- `idle_no_ready`: plan is not terminal/completed, but there is no currently runnable packet.

## Cycle stop-reason invariants

Single-cycle stop reasons (`CycleProgressReason`):
- `plan_completed`: reconcile ended with full plan completion.
- `reconciled_progress`: reconcile changed completion/unlock state.
- `dispatched_packets`: dispatcher sent at least one packet this cycle.
- `no_ready_packets`: no runnable work was dispatched and no reconcile progress happened.

Run-until-blocked stop reasons (`RunUntilBlockedStopReason`):
- `plan_completed`: plan reached terminal completion.
- `blocked_waiting`: cycle stopped with no ready packets while waiting packets remain.
- `no_ready_packets`: cycle stopped with no ready packets and no waiting packets remain.
- `max_iterations_reached`: loop hit the max cycle budget before a terminal stop.

## Dry-run dispatcher reason invariants

Dry-run decisions stay explicit and machine-friendly using snake_case reason codes:
- `dry_run_simulated_dispatch`
- `dry_run_marked_only`
- `skipped_not_ready`
- `skipped_already_has_session`
- `skipped_dependency_not_satisfied`
- `skipped_risk_or_approval_block`
- `skipped_no_dispatch_capacity`
- `dispatched_to_session` (typed reason key reserved for dispatcher mode compatibility)
