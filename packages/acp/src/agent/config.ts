import { RequestError } from '@agentclientprotocol/sdk';
import type {
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionModeState,
} from '@agentclientprotocol/sdk';
import type { PermissionMode, ReasoningEffort } from '@cogitator-ai/types';

/** The ids of the configuration options a session offers */
export const ACP_CONFIG_IDS = {
  mode: 'mode',
  model: 'model',
  effort: 'reasoning_effort',
} as const;

/** The reasoning effort of a session: one of the model's levels, or `default` for the agent's own */
export type SessionEffort = ReasoningEffort | 'default';

/** What a session runs with: the permission mode, the model and the reasoning effort */
export interface SessionSettings {
  mode: PermissionMode;
  model: string;
  effort: SessionEffort;
}

/** What an editor may pick from */
export interface SettingChoices {
  modes: readonly PermissionMode[];
  models: readonly string[];
  efforts: readonly SessionEffort[];
}

const MODE_TEXT: Readonly<Record<PermissionMode, { name: string; description: string }>> = {
  default: {
    name: 'Ask',
    description: 'Reads run freely, edits and commands ask first',
  },
  acceptEdits: {
    name: 'Accept edits',
    description: 'Edits of files in the project run without asking, commands still ask',
  },
  plan: {
    name: 'Plan',
    description: 'Only reads run until you approve a plan',
  },
  auto: {
    name: 'Auto',
    description: 'A classifier model decides what would ask',
  },
  dontAsk: {
    name: "Don't ask",
    description: 'What would ask is refused, what the rules allow runs',
  },
  bypassPermissions: {
    name: 'Bypass permissions',
    description: 'Everything runs but what a deny rule refuses. Only in a sandbox',
  },
};

const EFFORT_TEXT: Readonly<Record<SessionEffort, string>> = {
  default: 'Default',
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** The modes offered when none are named: every mode but `auto`, which needs a classifier */
export const DEFAULT_ACP_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
];

/** The reasoning efforts offered when none are named */
export const DEFAULT_ACP_EFFORTS: readonly SessionEffort[] = [
  'default',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** The permission modes as ACP session modes, the one in use marked */
export function modeState(
  modes: readonly PermissionMode[],
  current: PermissionMode
): SessionModeState {
  return {
    currentModeId: current,
    availableModes: modes.map((mode) => ({ id: mode, ...MODE_TEXT[mode] })),
  };
}

function select(
  id: string,
  name: string,
  category: string,
  currentValue: string,
  options: SessionConfigSelectOption[],
  description: string
): SessionConfigOption {
  return { type: 'select', id, name, category, description, currentValue, options };
}

/** The configuration options of a session: its mode, its model and its reasoning effort */
export function configOptions(
  settings: SessionSettings,
  choices: SettingChoices
): SessionConfigOption[] {
  const models = choices.models.includes(settings.model)
    ? choices.models
    : [settings.model, ...choices.models];
  return [
    select(
      ACP_CONFIG_IDS.mode,
      'Mode',
      'mode',
      settings.mode,
      choices.modes.map((mode) => ({
        value: mode,
        name: MODE_TEXT[mode].name,
        description: MODE_TEXT[mode].description,
      })),
      'How tool calls are allowed'
    ),
    select(
      ACP_CONFIG_IDS.model,
      'Model',
      'model',
      settings.model,
      models.map((model) => ({ value: model, name: model })),
      'The model the agent runs, as provider/model'
    ),
    select(
      ACP_CONFIG_IDS.effort,
      'Reasoning effort',
      'thought_level',
      settings.effort,
      choices.efforts.map((effort) => ({ value: effort, name: EFFORT_TEXT[effort] })),
      'How much the model thinks before it answers, for models that reason'
    ),
  ];
}

function isMode(value: string, choices: SettingChoices): value is PermissionMode {
  return (choices.modes as readonly string[]).includes(value);
}

function isEffort(value: string, choices: SettingChoices): value is SessionEffort {
  return (choices.efforts as readonly string[]).includes(value);
}

/** The settings with one option set, refusing an option or a value the session does not offer */
export function applyConfigOption(
  settings: SessionSettings,
  configId: string,
  value: string | boolean,
  choices: SettingChoices
): SessionSettings {
  if (typeof value !== 'string') {
    throw RequestError.invalidParams(
      { configId },
      `${configId} takes one of its values, not a boolean`
    );
  }
  switch (configId) {
    case ACP_CONFIG_IDS.mode:
      if (!isMode(value, choices)) {
        throw RequestError.invalidParams({ configId, value }, `Unknown mode ${value}`);
      }
      return { ...settings, mode: value };
    case ACP_CONFIG_IDS.model:
      if (!choices.models.includes(value) && value !== settings.model) {
        throw RequestError.invalidParams({ configId, value }, `Unknown model ${value}`);
      }
      return { ...settings, model: value };
    case ACP_CONFIG_IDS.effort:
      if (!isEffort(value, choices)) {
        throw RequestError.invalidParams({ configId, value }, `Unknown reasoning effort ${value}`);
      }
      return { ...settings, effort: value };
    default:
      throw RequestError.invalidParams({ configId }, `Unknown configuration option ${configId}`);
  }
}

/** Whether `value` is a mode the session offers */
export function offeredMode(value: string, choices: SettingChoices): PermissionMode | undefined {
  return isMode(value, choices) ? value : undefined;
}
