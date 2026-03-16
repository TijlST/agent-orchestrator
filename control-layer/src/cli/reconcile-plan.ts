import { runReconcilerStub } from '../reconciler/reconciler-stub.js';

interface ReconcilePlanCliArgs {
  planId?: string;
  packetFile?: string;
}

function usage(): string {
  return [
    'Usage:',
    '  npm run reconcile-plan -- --plan-id "<PLAN_ID>"',
    '  npm run reconcile-plan -- --plan-id "<PLAN_ID>" --packet-file "<PATH>"',
  ].join('\n');
}

function parseArgs(argv: string[]): ReconcilePlanCliArgs {
  const args: ReconcilePlanCliArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--plan-id') {
      args.planId = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === '--packet-file') {
      args.packetFile = argv[index + 1];
      index += 1;
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.planId && !args.packetFile) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const result = await runReconcilerStub({
    planId: args.planId,
    packetFile: args.packetFile,
  });

  console.log(`Plan ID: ${result.planId}`);
  console.log(`Plan file: ${result.planFilePath}`);
  console.log(`Packet file: ${result.packetFilePath}`);
  console.log(`Packets evaluated: ${result.evaluatedPacketCount}`);
  console.log(`Packets completed: ${result.completedCount}`);
  console.log(`Packets requeued: ${result.requeuedCount}`);
  console.log(`Packets failed: ${result.failedCount}`);
  console.log(`Packets unlocked: ${result.unlockedCount}`);
  console.log(`Plan completed: ${result.planCompleted ? 'yes' : 'no'}`);
  console.log(`Summary: ${JSON.stringify(result.summary)}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to reconcile plan: ${message}`);
  process.exitCode = 1;
});
