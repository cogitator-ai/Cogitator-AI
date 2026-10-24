import type {
  DeployConfig,
  DeployResult,
  DeployStatus,
  PreflightResult,
  GeneratedArtifacts,
} from '@cogitator-ai/types';

/** A command a caller runs with its output on the terminal, as argv: no shell reads it. */
export interface DeployCommand {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** What `logsCommand` shows. */
export interface DeployLogsOptions {
  /** Keep streaming new lines, else print the recent ones and exit */
  follow?: boolean;
  /** Lines from the end of the logs, a number or `all`. Docker target only, 100 by default */
  tail?: string;
  /** The Docker Compose service to show (`app`, `ollama`, `redis`), every one when unset. Docker target only */
  service?: string;
  /** Prefix lines with their time. Fly logs always carry it */
  timestamps?: boolean;
}

export interface DeployProvider {
  readonly name: string;

  preflight(config: DeployConfig, projectDir: string): Promise<PreflightResult>;
  generate(config: DeployConfig, projectDir: string): Promise<GeneratedArtifacts>;
  deploy(
    config: DeployConfig,
    artifacts: GeneratedArtifacts,
    projectDir: string
  ): Promise<DeployResult>;
  status(config: DeployConfig, projectDir: string): Promise<DeployStatus>;
  destroy(config: DeployConfig, projectDir: string): Promise<void>;
  /**
   * The command that shows the logs of the deployment. It throws when the
   * deployment cannot be found or the options do not apply to the target.
   */
  logsCommand?(config: DeployConfig, projectDir: string, options: DeployLogsOptions): DeployCommand;
}
