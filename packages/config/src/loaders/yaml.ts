/**
 * YAML configuration loader
 */

import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';
import type { CogitatorConfigInput } from '../schema';

const DEFAULT_CONFIG_NAMES = ['cogitator.yaml', 'cogitator.yml', '.cogitator.yaml', '.cogitator.yml'];

export function loadYamlConfig(configPath?: string): CogitatorConfigInput | null {
  if (configPath) {
    if (!existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    return parseYamlFile(configPath);
  }

  for (const name of DEFAULT_CONFIG_NAMES) {
    if (existsSync(name)) {
      return parseYamlFile(name);
    }
  }

  return null;
}

function parseYamlFile(path: string): CogitatorConfigInput {
  const content = readFileSync(path, 'utf-8');
  return parse(content) as CogitatorConfigInput;
}
