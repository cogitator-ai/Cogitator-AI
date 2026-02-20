import type {
  DeployConfig,
  DeployResult,
  DeployStatus,
  PreflightResult,
  GeneratedArtifacts,
} from '@cogitator-ai/types';

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
}
