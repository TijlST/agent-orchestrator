import { relative } from 'node:path';

import { getPlanStatusSummary } from '../status/plan-status.js';

interface PlanStatusCliArgs {
  planId?: string;
  json: boolean;
}

function usage(): string {
  return 'Usage: npm run plan-status -- --plan-id "<PLAN_ID>" [--json]';
}

function parseArgs(argv: string[]): PlanStatusCliArgs {
  const args: PlanStatusCliArgs = {
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--plan-id') {
      args.planId = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === '--json') {
      args.json = true;
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

  const summary = await getPlanStatusSummary({
    planId: args.planId,
  });

  if (args.json) {
    console.log(JSON.stringify(summary.operatorSummary));
    return;
  }

  const cwd = process.cwd();

  console.log(`Plan ID: ${summary.planId}`);
  console.log(`Goal: ${summary.goal?.trim() ? summary.goal : '(not available)'}`);
  console.log(`Plan file: ${relative(cwd, summary.planFilePath)}`);
  console.log(`Packet file: ${relative(cwd, summary.packetFilePath)}`);
  console.log(`Plan status: ${summary.planStatus}`);
  console.log(`Operator state: ${summary.operatorState}`);
  console.log(`Plan completed: ${summary.planCompleted ? 'yes' : 'no'}`);
  console.log(`Packet counts: ${JSON.stringify(summary.counts)}`);
  console.log(
    `Latest dispatch: ${
      summary.latestDispatchOutcome
        ? `${summary.latestDispatchOutcome.timestamp} | ${summary.latestDispatchOutcome.eventType} | ${summary.latestDispatchOutcome.result}${summary.latestDispatchOutcome.reason ? ` | reason:${summary.latestDispatchOutcome.reason}` : ''}`
        : '(none)'
    }`,
  );
  console.log(
    `Latest reconcile: ${
      summary.latestReconcileOutcome
        ? `${summary.latestReconcileOutcome.timestamp} | ${summary.latestReconcileOutcome.eventType} | ${summary.latestReconcileOutcome.result}${summary.latestReconcileOutcome.reason ? ` | reason:${summary.latestReconcileOutcome.reason}` : ''}`
        : '(none)'
    }`,
  );
  console.log(`Latest stop reasons: ${JSON.stringify(summary.latestStopReasons)}`);
  console.log(JSON.stringify(summary.operatorSummary));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to inspect plan status: ${message}`);
  process.exitCode = 1;
});
