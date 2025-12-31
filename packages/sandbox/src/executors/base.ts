/**
 * Base sandbox executor interface
 */

import type {
  SandboxConfig,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxResult,
} from '@cogitator-ai/types';

export abstract class BaseSandboxExecutor {
  abstract readonly type: string;

  abstract execute(
    request: SandboxExecutionRequest,
    config: SandboxConfig
  ): Promise<SandboxResult<SandboxExecutionResult>>;

  abstract connect(): Promise<SandboxResult<void>>;
  abstract disconnect(): Promise<SandboxResult<void>>;
  abstract isAvailable(): Promise<boolean>;

  protected success<T>(data: T): SandboxResult<T> {
    return { success: true, data };
  }

  protected failure(error: string): SandboxResult<never> {
    return { success: false, error };
  }
}
