/**
 * Skill types for declarative tool + instruction bundles
 */

import type { Tool } from './tool';

export interface SkillConfig {
  name: string;
  version: string;
  description: string;
  tools: Tool[];
  instructions?: string;
  env?: string[];
  dependencies?: string[];
}

export interface Skill {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly tools: Tool[];
  readonly instructions?: string;
  readonly env?: string[];
  readonly dependencies?: string[];
}

export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  missingEnv: string[];
  missingDependencies: string[];
}

export interface SkillLoader {
  load(name: string): Promise<Skill>;
  loadAll(): Promise<Skill[]>;
  validate(skill: Skill): SkillValidationResult;
}
