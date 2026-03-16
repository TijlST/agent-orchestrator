import { relative } from 'node:path';

import { runPlanCycle } from '../loop/plan-cycle-runner.js';

interface RunPlanCycleCliArgs {
  planId?: string;
}

function usage(): string {
  return 'Usage: npm run run-plan-cycle -- --plan-id "<PLAN_ID>"';
}

function parseArgs(argv: string[]): RunPlanCycleCliArgs {
  const args: RunPlanCycleCliArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--plan-id') {
      args.planId = argv[index + 1];
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

  const result = await runPlanCycle({
    planId: args.planId,
  });

  const cwd = process.cwd();

  console.log(`Plan ID: ${result.planId}`);
  console.log(`Plan file: ${relative(cwd, result.planFilePath)}`);
  console.log(`Packet file: ${relative(cwd, result.packetFilePath)}`);
  console.log(`Ready before dispatch: ${result.readyBeforeDispatch}`);
  console.log(`Packets dispatched: ${result.dispatchedCount}`);
  console.log(`Packets completed: ${result.completedCount}`);
  console.log(`Packets unlocked: ${result.unlockedCount}`);
  console.log(`Stop reason: ${result.stopReason}`);
  console.log(`Remaining queued: ${result.remainingQueued}`);
  console.log(`Remaining ready: ${result.remainingReady}`);
  console.log(`Remaining waiting: ${result.remainingWaiting}`);
  console.log(`Plan completed: ${result.planCompleted ? 'yes' : 'no'}`);
  console.log(`Operator state: ${result.operatorState}`);
  console.log(`Packet counts: ${JSON.stringify(result.packetCounts)}`);
  console.log(`Latest stop reasons: ${JSON.stringify(result.latestStopReasons)}`);
  console.log(
    JSON.stringify({
      planId: result.planId,
      stopReason: result.stopReason,
      operatorState: result.operatorState,
      packetCounts: result.packetCounts,
      latestStopReasons: result.latestStopReasons,
    }),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to run plan cycle: ${message}`);
  process.exitCode = 1;
});
