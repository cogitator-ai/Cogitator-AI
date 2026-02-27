import type { Skill, SkillConfig, SkillValidationResult, Tool } from '@cogitator-ai/types';

export function defineSkill(config: SkillConfig): Skill {
  return {
    name: config.name,
    version: config.version,
    description: config.description,
    tools: config.tools,
    instructions: config.instructions,
    env: config.env,
    dependencies: config.dependencies,
  };
}

export function mergeSkillsIntoAgent(
  tools: Tool[],
  instructions: string,
  skills: Skill[]
): { tools: Tool[]; instructions: string } {
  const mergedTools = [...tools];
  const instructionParts = [instructions];

  for (const skill of skills) {
    for (const tool of skill.tools) {
      if (!mergedTools.some((t) => t.name === tool.name)) {
        mergedTools.push(tool);
      }
    }

    if (skill.instructions) {
      instructionParts.push(skill.instructions);
    }
  }

  return {
    tools: mergedTools,
    instructions: instructionParts.join('\n\n'),
  };
}

export function validateSkill(skill: Skill): SkillValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const missingEnv: string[] = [];
  const missingDependencies: string[] = [];

  if (!skill.name || skill.name.trim().length === 0) {
    errors.push('Skill name is required');
  }

  if (!skill.version || skill.version.trim().length === 0) {
    errors.push('Skill version is required');
  }

  if (!skill.tools || skill.tools.length === 0) {
    warnings.push('Skill has no tools');
  }

  if (skill.env) {
    for (const envVar of skill.env) {
      if (!process.env[envVar]) {
        missingEnv.push(envVar);
      }
    }
  }

  if (skill.dependencies) {
    for (const dep of skill.dependencies) {
      try {
        require.resolve(dep);
      } catch {
        missingDependencies.push(dep);
      }
    }
  }

  if (missingEnv.length > 0) {
    errors.push(`Missing environment variables: ${missingEnv.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    missingEnv,
    missingDependencies,
  };
}
