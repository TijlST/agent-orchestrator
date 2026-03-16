import { relative } from 'node:path';

import { runUntilBlocked } from '../loop/run-until-blocked.js';

interface RunUntilBlockedCliArgs {
  planId?: string;
  maxCycles?: number;
}

function usage(): string {
  return 'Usage: npm run run-until-blocked -- --plan-id "<PLAN_ID>" [--max-cycles 20]';
}

function parseArgs(argv: string[]): RunUntilBlockedCliArgs {
  const args: RunUntilBlockedCliArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--plan-id') {
      args.planId = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === '--max-cycles') {
      const value = argv[index + 1];
      args.maxCycles = value ? Number(value) : Number.NaN;
      index += 1;
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.planId) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const result = await runUntilBlocked({
    planId: args.planId,
    maxCycles: args.maxCycles,
  });

  const cwd = process.cwd();

  console.log(`Plan ID: ${result.planId}`);
  console.log(`Plan file: ${relative(cwd, result.planFilePath)}`);
  console.log(`Packet file: ${relative(cwd, result.packetFilePath)}`);
  console.log(`Cycles executed: ${result.cyclesExecuted}`);
  console.log(`Total dispatched: ${result.totalDispatched}`);
  console.log(`Total completed: ${result.totalCompleted}`);
  console.log(`Total unlocked: ${result.totalUnlocked}`);
  console.log(`Remaining queued: ${result.remainingQueued}`);
  console.log(`Remaining ready: ${result.remainingReady}`);
  console.log(`Remaining waiting: ${result.remainingWaiting}`);
  console.log(`Stop reason: ${result.stopReason}`);
  if (result.lastCycleStopReason) {
    console.log(`Last cycle reason: ${result.lastCycleStopReason}`);
  }
  console.log(`Plan completed: ${result.planCompleted ? 'yes' : 'no'}`);
  console.log(`Operator state: ${result.operatorState}`);
  console.log(`Packet counts: ${JSON.stringify(result.packetCounts)}`);
  console.log(`Latest stop reasons: ${JSON.stringify(result.latestStopReasons)}`);
  console.log(
    JSON.stringify({
      planId: result.planId,
      stopReason: result.stopReason,
      lastCycleStopReason: result.lastCycleStopReason,
      operatorState: result.operatorState,
      packetCounts: result.packetCounts,
      latestStopReasons: result.latestStopReasons,
    }),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to run until blocked: ${message}`);
  process.exitCode = 1;
});
