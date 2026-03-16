import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { runSingleCycle } from './single-cycle-runner.js';
import type { DispatchResult, DispatcherInput } from '../types/dispatcher.js';
import type { ReconcileResult, ReconcilerInput } from '../types/reconciler.js';

const FIXED_TIME = '2026-03-16T12:00:00.000Z';

function createDispatchResult(input: DispatcherInput, dispatchedCount: number): DispatchResult {
  const packetFilePath = resolve(process.cwd(), input.packetFile ?? 'state/packets/unknown.json');
  return {
    planId: input.planId ?? 'plan-test',
    packetFilePath,
    evaluatedCount: 0,
    dispatchedCount,
    skippedCount: 0,
    dispatchedPacketIds: [],
    decisions: [],
    decisionCounts: {
      dispatched_to_session: 0,
      dry_run_marked_only: 0,
      dry_run_simulated_dispatch: dispatchedCount,
      skipped_not_ready: 0,
      skipped_already_has_session: 0,
      skipped_dependency_not_satisfied: 0,
      skipped_risk_or_approval_block: 0,
      skipped_no_dispatch_capacity: 0,
    },
    packets: [],
  };
}

function createReconcileResult(
  input: ReconcilerInput,
  stateRoot: string,
  overrides: Partial<ReconcileResult>,
): ReconcileResult {
  const planId = input.planId ?? 'plan-test';
  const packetFilePath = resolve(process.cwd(), input.packetFile ?? 'state/packets/unknown.json');

  return {
    planId,
    planFilePath: join(stateRoot, 'plans', `${planId}.json`),
    packetFilePath,
    evaluatedPacketCount: 0,
    completedCount: 0,
    requeuedCount: 0,
    failedCount: 0,
    unlockedCount: 0,
    planCompleted: false,
    summary: {
      completedPackets: 0,
      requeuedPackets: 0,
      failedPackets: 0,
      unlockedPackets: 0,
      planCompleted: false,
    },
    decisions: [],
    ...overrides,
  };
}

test('single-cycle reports no_ready_packets when nothing can run', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'single-cycle-no-ready-'));
  const stateRoot = join(rootDir, 'state');

  try {
    const result = await runSingleCycle(
      { goal: 'No ready work' },
      {
        stateRoot,
        now: () => FIXED_TIME,
        dispatchRunner: async (input) => createDispatchResult(input, 0),
        reconcileRunner: async (input) =>
          createReconcileResult(input, stateRoot, {
            completedCount: 0,
            unlockedCount: 0,
            planCompleted: false,
          }),
      },
    );

    assert.equal(result.stopReason, 'no_ready_packets');
    assert.equal(result.operatorState, 'progressing');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('single-cycle reports dispatched_packets when dispatch occurs', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'single-cycle-dispatched-'));
  const stateRoot = join(rootDir, 'state');

  try {
    const result = await runSingleCycle(
      { goal: 'Dispatch-only cycle' },
      {
        stateRoot,
        now: () => FIXED_TIME,
        dispatchRunner: async (input) => createDispatchResult(input, 1),
        reconcileRunner: async (input) =>
          createReconcileResult(input, stateRoot, {
            completedCount: 0,
            unlockedCount: 0,
            planCompleted: false,
          }),
      },
    );

    assert.equal(result.stopReason, 'dispatched_packets');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('single-cycle consumes dispatcher decision payloads without live AO dependencies', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'single-cycle-dispatch-result-shape-'));
  const stateRoot = join(rootDir, 'state');

  try {
    const result = await runSingleCycle(
      { goal: 'Dispatch result compatibility' },
      {
        stateRoot,
        now: () => FIXED_TIME,
        dispatchRunner: async (input) => {
          const base = createDispatchResult(input, 1);
          return {
            ...base,
            evaluatedCount: 2,
            skippedCount: 1,
            decisions: [
              {
                planId: base.planId,
                packetId: 'packet-dispatched',
                action: 'send_instruction',
                fromStatus: 'ready',
                toStatus: 'dispatching',
                mode: 'ao-dry-run',
                outcome: 'dispatched',
                reason: 'dry_run_simulated_dispatch',
                correlationId: 'packet-dispatched-corr',
              },
              {
                planId: base.planId,
                packetId: 'packet-skipped',
                action: 'send_instruction',
                fromStatus: 'waiting',
                toStatus: 'waiting',
                mode: 'ao-dry-run',
                outcome: 'skipped',
                reason: 'skipped_not_ready',
                correlationId: 'packet-skipped-corr',
              },
            ],
            decisionCounts: {
              dispatched_to_session: 0,
              dry_run_marked_only: 0,
              dry_run_simulated_dispatch: 1,
              skipped_not_ready: 1,
              skipped_already_has_session: 0,
              skipped_dependency_not_satisfied: 0,
              skipped_risk_or_approval_block: 0,
              skipped_no_dispatch_capacity: 0,
            },
          };
        },
        reconcileRunner: async (input) =>
          createReconcileResult(input, stateRoot, {
            completedCount: 0,
            unlockedCount: 0,
            planCompleted: false,
          }),
      },
    );

    assert.equal(result.stopReason, 'dispatched_packets');
    assert.equal(result.dispatchedCount, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('single-cycle reports reconciled_progress when reconcile changes packet states', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'single-cycle-reconciled-'));
  const stateRoot = join(rootDir, 'state');

  try {
    const result = await runSingleCycle(
      { goal: 'Reconcile-progress cycle' },
      {
        stateRoot,
        now: () => FIXED_TIME,
        dispatchRunner: async (input) => createDispatchResult(input, 0),
        reconcileRunner: async (input) =>
          createReconcileResult(input, stateRoot, {
            completedCount: 1,
            unlockedCount: 0,
            planCompleted: false,
            summary: {
              completedPackets: 1,
              requeuedPackets: 0,
              failedPackets: 0,
              unlockedPackets: 0,
              planCompleted: false,
            },
          }),
      },
    );

    assert.equal(result.stopReason, 'reconciled_progress');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
