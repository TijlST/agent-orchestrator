import { runDispatcher } from '../dispatcher/run-dispatcher.js';
import type { DispatcherMode } from '../types/dispatcher.js';

interface DispatchReadyCliArgs {
  planId?: string;
  packetFile?: string;
  mode?: DispatcherMode;
  sessionId?: string;
}

function usage(): string {
  return [
    'Usage:',
    '  npm run dispatch-ready -- --plan-id "<PLAN_ID>" [--mode stub|ao-dry-run|ao-exec] [--session-id "<SESSION_ID>"]',
    '  npm run dispatch-ready -- --plan-id "<PLAN_ID>" --packet-file "<PATH>" [--mode stub|ao-dry-run|ao-exec] [--session-id "<SESSION_ID>"]',
  ].join('\n');
}

function parseArgs(argv: string[]): DispatchReadyCliArgs {
  const args: DispatchReadyCliArgs = {};

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
      continue;
    }

    if (token === '--mode') {
      const mode = argv[index + 1];
      if (mode === 'stub' || mode === 'ao-dry-run' || mode === 'ao-exec') {
        args.mode = mode;
      }
      index += 1;
      continue;
    }

    if (token === '--session-id') {
      args.sessionId = argv[index + 1];
      index += 1;
      continue;
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

  if (process.argv.includes('--mode') && !args.mode) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const result = await runDispatcher({
    planId: args.planId,
    packetFile: args.packetFile,
    mode: args.mode,
    sessionId: args.sessionId,
  });

  console.log(`Plan ID: ${result.planId}`);
  console.log(`Packet file: ${result.packetFilePath}`);
  console.log(`Packets evaluated: ${result.evaluatedCount}`);
  console.log(`Packets dispatched: ${result.dispatchedCount}`);
  console.log(
    `Packet IDs dispatched: ${result.dispatchedPacketIds.length > 0 ? result.dispatchedPacketIds.join(', ') : '(none)'}`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to dispatch ready packets: ${message}`);
  process.exitCode = 1;
});
