import { runDispatcherAoDryRun } from './dispatcher-ao-dry-run.js';
import { runDispatcherAoExec } from './dispatcher-ao-exec.js';
import { runDispatcherStub } from './dispatcher-stub.js';
import type {
  DispatchResult,
  DispatcherInput,
  DispatcherMode,
} from '../types/dispatcher.js';

function resolveDispatcherMode(inputMode?: DispatcherMode): DispatcherMode {
  if (inputMode) {
    return inputMode;
  }

  const envMode = process.env.CONTROL_LAYER_DISPATCHER_MODE;
  if (envMode === 'stub' || envMode === 'ao-dry-run' || envMode === 'ao-exec') {
    return envMode;
  }

  return 'stub';
}

export async function runDispatcher(input: DispatcherInput): Promise<DispatchResult> {
  const mode = resolveDispatcherMode(input.mode);
  const normalizedInput: DispatcherInput = {
    ...input,
    mode,
  };

  if (mode === 'ao-dry-run') {
    return runDispatcherAoDryRun(normalizedInput);
  }

  if (mode === 'ao-exec') {
    return runDispatcherAoExec(normalizedInput);
  }

  return runDispatcherStub(normalizedInput);
}
