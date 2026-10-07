import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import {
  APP_CHOICES,
  CHANNEL_CHOICES,
  CODING_AGENT_CHOICES,
  DEPLOY_CHOICES,
  FEATURE_CHOICES,
  MEMORY_CHOICES,
  SERVER_CHOICES,
  VECTOR_STORE_CHOICES,
} from '../kit/catalog.js';
import { modelChoices } from '../kit/models.js';
import { DEFAULT_PRESET, PRESETS } from '../kit/presets.js';
import { PROVIDER_INFO, providerInfo } from '../kit/providers.js';
import { PROVIDERS, validateProjectName, type CodingAgent } from '../kit/spec.js';
import type { CliArgs } from './args.js';
import { DEFAULT_DIRECTORY, projectNameFromDirectory } from './resolve.js';

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

/** The answer to a prompt, or a CancelledError when the user pressed Ctrl+C. */
function answer<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) throw new CancelledError();
  return value as Exclude<T, symbol>;
}

const CUSTOM = '__custom__';
const OTHER_MODEL = '__other__';

/** Coding agents whose config directory exists in the home directory, offered preselected. */
export function detectCodingAgents(home: string = homedir()): CodingAgent[] {
  const markers: Record<CodingAgent, string> = {
    claude: '.claude',
    cursor: '.cursor',
    codex: '.codex',
  };
  return CODING_AGENT_CHOICES.map((choice) => choice.value).filter((agent) =>
    existsSync(join(home, markers[agent]))
  );
}

/**
 * Asks for everything the flags left open and returns the flags completed with
 * the answers. Anything given as a flag is not asked again.
 */
export async function askMissing(args: CliArgs): Promise<CliArgs> {
  const next: CliArgs = { ...args };

  if (next.directory === undefined) {
    next.directory = answer(
      await p.text({
        message: 'Where should the project go?',
        placeholder: `./${DEFAULT_DIRECTORY}`,
        defaultValue: DEFAULT_DIRECTORY,
        validate: (value) =>
          value?.trim() ? validateProjectName(projectNameFromDirectory(value)) : undefined,
      })
    ).trim();
  }

  if (next.preset === undefined && next.app === undefined) {
    const choice = answer(
      await p.select<string>({
        message: 'What do you want to build?',
        options: [
          ...PRESETS.map((preset) => ({
            value: preset.id,
            label: preset.label,
            hint: preset.hint,
          })),
          {
            value: CUSTOM,
            label: 'Custom stack',
            hint: 'pick the app, memory and features yourself',
          },
        ],
        initialValue: DEFAULT_PRESET,
        maxItems: 10,
      })
    );
    if (choice === CUSTOM) Object.assign(next, await askStack(next));
    else next.preset = choice;
  }

  const presetProvider = PRESETS.find((preset) => preset.id === next.preset)?.spec.provider;
  if (next.provider === undefined) {
    next.provider = answer(
      await p.select({
        message: 'Which model provider?',
        options: PROVIDERS.map((id) => ({
          value: id,
          label: PROVIDER_INFO[id].label,
          hint: PROVIDER_INFO[id].hint,
        })),
        initialValue: presetProvider ?? 'ollama',
      })
    );
  }
  const provider = next.provider;

  if (next.model === undefined) {
    const spinner = p.spinner();
    spinner.start('Looking up models');
    const { choices, source } = await modelChoices(provider);
    spinner.stop(
      source === 'ollama'
        ? 'Found the models in your Ollama'
        : source === 'suggested'
          ? 'Ollama is not running, so here are good small models to pull'
          : `Found the current ${providerInfo(provider).label} models`
    );
    const picked = answer(
      await p.select<string>({
        message: 'Which model?',
        options: [...choices, { value: OTHER_MODEL, label: 'Another model', hint: 'type its id' }],
        initialValue: choices[0]?.value,
        maxItems: 10,
      })
    );
    next.model =
      picked === OTHER_MODEL
        ? answer(
            await p.text({
              message: `Model id at ${providerInfo(provider).label}`,
              validate: (value) => (value?.trim() ? undefined : 'Type a model id'),
            })
          ).trim()
        : picked;
  }

  const envKey = providerInfo(provider).envKey;
  if (envKey && next.apiKey === undefined) {
    const fromShell = process.env[envKey]?.trim();
    if (fromShell) {
      const copy = answer(
        await p.confirm({
          message: `Copy ${envKey} from your shell into the project's .env?`,
          initialValue: true,
        })
      );
      if (copy) next.apiKey = fromShell;
    } else {
      const key = answer(
        await p.password({
          message: `${envKey} (leave empty to add it to .env later)`,
          mask: '*',
        })
      ).trim();
      if (key) next.apiKey = key;
    }
  }

  if (next.codingAgents === undefined) {
    const detected = detectCodingAgents();
    next.codingAgents = answer(
      await p.multiselect<CodingAgent>({
        message: 'Set the project up for your coding agent? (AGENTS.md is always written)',
        options: CODING_AGENT_CHOICES,
        initialValues: detected,
        required: false,
      })
    );
  }

  return next;
}

/** The stack questions of a custom project. */
async function askStack(args: CliArgs): Promise<Partial<CliArgs>> {
  const app =
    args.app ??
    answer(
      await p.select({
        message: 'Which kind of app?',
        options: APP_CHOICES,
        initialValue: 'script',
      })
    );
  const result: Partial<CliArgs> = { app };

  if (app === 'server' && args.server === undefined) {
    result.server = answer(
      await p.select({
        message: 'Which server framework?',
        options: SERVER_CHOICES,
        initialValue: 'hono',
      })
    );
  }
  if (app === 'channels' && args.channels === undefined) {
    result.channels = answer(
      await p.multiselect({
        message: 'Which channels?',
        options: CHANNEL_CHOICES,
        initialValues: ['webchat'],
        required: true,
      })
    );
  }
  if (args.memory === undefined) {
    result.memory = answer(
      await p.select({
        message: 'Where should conversations be stored?',
        options: MEMORY_CHOICES,
        initialValue: 'sqlite',
      })
    );
  }
  if (args.features === undefined) {
    const features = answer(
      await p.multiselect({
        message: 'Which features? (space to toggle)',
        options: FEATURE_CHOICES,
        required: false,
      })
    );
    if (features.includes('durable') && !features.includes('workflows')) features.push('workflows');
    result.features = features;
    if (features.includes('rag') && args.vectorStore === undefined) {
      result.vectorStore = answer(
        await p.select({
          message: 'Where should RAG keep its vectors?',
          options: VECTOR_STORE_CHOICES,
          initialValue: 'memory',
        })
      );
    }
  }
  if (args.deploy === undefined) {
    result.deploy = answer(
      await p.select({
        message: 'How will you deploy it?',
        options: DEPLOY_CHOICES,
        initialValue: 'docker',
      })
    );
  }
  return result;
}
