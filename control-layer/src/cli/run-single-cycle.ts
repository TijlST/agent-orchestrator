import { relative } from 'node:path';

import { runSingleCycle } from '../loop/single-cycle-runner.js';

function usage(): string {
  return 'Usage: npm run run-single-cycle -- "<goal>"';
}

async function main(): Promise<void> {
  const goal = process.argv.slice(2).join(' ').trim();
  if (!goal) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const result = await runSingleCycle({ goal });
  const cwd = process.cwd();

  console.log(`Plan ID: ${result.planId}`);
  console.log(`Plan file: ${relative(cwd, result.planFilePath)}`);
  console.log(`Packet file: ${relative(cwd, result.packetFilePath)}`);
  console.log(`Packets dispatched: ${result.dispatchedCount}`);
  console.log(`Packets completed: ${result.completedCount}`);
  console.log(`Packets unlocked: ${result.unlockedCount}`);
  console.log(`Stop reason: ${result.stopReason}`);
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
  console.error(`Failed to run single cycle: ${message}`);
  process.exitCode = 1;
});
