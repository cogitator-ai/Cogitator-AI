/** Routines and their triggers: ids, checks, and what of a trigger may be shown or stored */

import type {
  RoutineDefinition,
  TriggerSecret,
  TriggerSpec,
  TriggerSpecSummary,
} from '@cogitator-ai/types';

/** A routine id: a plugin's routines are `plugin:id` */
export const ROUTINE_ID = /^[a-z0-9][a-z0-9_:-]*$/;
/** A trigger id within its routine */
export const TRIGGER_ID = /^[a-z0-9][a-z0-9_-]*$/;
/** The most records of history a store keeps per routine */
export const MAX_RUN_HISTORY = 200;

/** A trigger's id within its routine: its own, else its kind */
export function triggerIdOf(spec: TriggerSpec): string {
  return spec.id ?? spec.kind;
}

/** The id of a trigger the HTTP routes take: `<routineId>.<triggerId>` */
export function fullTriggerId(routineId: string, triggerId: string): string {
  return `${routineId}.${triggerId}`;
}

/** The routine and trigger of a full trigger id, undefined when it is not one */
export function splitTriggerId(id: string): { routineId: string; triggerId: string } | undefined {
  const at = id.lastIndexOf('.');
  if (at <= 0 || at === id.length - 1) return undefined;
  const routineId = id.slice(0, at);
  const triggerId = id.slice(at + 1);
  return ROUTINE_ID.test(routineId) && TRIGGER_ID.test(triggerId)
    ? { routineId, triggerId }
    : undefined;
}

/** What is wrong with a routine's shape, undefined when nothing is. Cron expressions are checked by the manager */
export function routineProblem(routine: RoutineDefinition): string | undefined {
  if (typeof routine.id !== 'string' || !ROUTINE_ID.test(routine.id)) {
    return `A routine id is lowercase letters, digits, "_", ":" and "-", got "${String(routine.id)}"`;
  }
  if (typeof routine.prompt !== 'string' || routine.prompt.trim() === '') {
    return `Routine ${routine.id} needs a prompt`;
  }
  const target = routine.target as Partial<Record<'agent' | 'workflow', unknown>> | undefined;
  if (!target || (target.agent === undefined) === (target.workflow === undefined)) {
    return `Routine ${routine.id} needs a target with an agent or a workflow`;
  }
  if (
    routine.maxConcurrent !== undefined &&
    !(Number.isInteger(routine.maxConcurrent) && routine.maxConcurrent >= 1)
  ) {
    return `Routine ${routine.id}: maxConcurrent must be a whole number of at least 1`;
  }
  if (routine.catchUpWindowMs !== undefined && !(routine.catchUpWindowMs >= 0)) {
    return `Routine ${routine.id}: catchUpWindowMs must be 0 or more`;
  }
  if (routine.session !== undefined && routine.session !== 'new') {
    const threadId = (routine.session as { threadId?: unknown }).threadId;
    if (typeof threadId !== 'string' || threadId === '') {
      return `Routine ${routine.id}: session is "new" or { threadId }`;
    }
  }
  const seen = new Set<string>();
  for (const spec of routine.triggers ?? []) {
    const id = triggerIdOf(spec);
    if (!TRIGGER_ID.test(id)) {
      return `Routine ${routine.id}: a trigger id is lowercase letters, digits, "_" and "-", got "${id}"`;
    }
    if (seen.has(id)) {
      return `Routine ${routine.id} has two triggers with the id "${id}": give one an id`;
    }
    seen.add(id);
    if (
      spec.maxPerHour !== undefined &&
      !(Number.isInteger(spec.maxPerHour) && spec.maxPerHour >= 1)
    ) {
      return `Trigger ${fullTriggerId(routine.id, id)}: maxPerHour must be a whole number of at least 1`;
    }
  }
  return undefined;
}

function plainSecret(secret: TriggerSecret | undefined): boolean {
  return typeof secret === 'string';
}

/**
 * Why a routine cannot be saved to a store, undefined when it can: a store keeps JSON, so its
 * target is named, and a secret goes by its environment variable, never as text
 */
export function storableProblem(routine: RoutineDefinition): string | undefined {
  const target = routine.target as Partial<Record<'agent' | 'workflow', unknown>>;
  if (
    (target.agent !== undefined && typeof target.agent !== 'string') ||
    (target.workflow !== undefined && typeof target.workflow !== 'string')
  ) {
    return `Routine ${routine.id}: a saved routine names its agent or workflow`;
  }
  for (const spec of routine.triggers ?? []) {
    const id = fullTriggerId(routine.id, triggerIdOf(spec));
    const secrets: (TriggerSecret | undefined)[] =
      spec.kind === 'api'
        ? [spec.token]
        : spec.kind === 'webhook' || spec.kind === 'github'
          ? [spec.secret]
          : spec.kind === 'slack'
            ? [spec.signingSecret]
            : spec.kind === 'email'
              ? [spec.signingKey, spec.token, spec.basicAuth?.password]
              : [];
    if (secrets.some(plainSecret)) {
      return `Trigger ${id}: a saved trigger takes its secret as { env: "NAME" }, not as text`;
    }
    if (spec.kind === 'email' && spec.parse !== undefined) {
      return `Trigger ${id}: a saved email trigger cannot have a parse function`;
    }
  }
  return undefined;
}

function secretSummary(secret: TriggerSecret | undefined): string | undefined {
  if (secret === undefined) return undefined;
  return typeof secret === 'string' ? 'set' : `env:${secret.env}`;
}

/** A trigger's spec as it may be shown: secrets as `set` or the variable that holds them */
export function specSummary(spec: TriggerSpec): TriggerSpecSummary {
  const base = { kind: spec.kind, id: triggerIdOf(spec) };
  const common = {
    ...(spec.enabled !== undefined && { enabled: spec.enabled }),
    ...(spec.maxPerHour !== undefined && { maxPerHour: spec.maxPerHour }),
  };
  switch (spec.kind) {
    case 'cron':
      return {
        ...base,
        ...common,
        cron: spec.cron,
        ...(spec.timezone !== undefined && { timezone: spec.timezone }),
      };
    case 'api':
      return {
        ...base,
        ...common,
        ...(spec.token !== undefined && { token: secretSummary(spec.token) }),
      };
    case 'webhook':
      return {
        ...base,
        ...common,
        secret: secretSummary(spec.secret),
        ...(spec.algorithm !== undefined && { algorithm: spec.algorithm }),
        ...(spec.signatureHeader !== undefined && { signatureHeader: spec.signatureHeader }),
        ...(spec.deliveryHeader !== undefined && { deliveryHeader: spec.deliveryHeader }),
      };
    case 'github':
      return {
        ...base,
        ...common,
        secret: secretSummary(spec.secret),
        ...(spec.events !== undefined && { events: [...spec.events] }),
        ...(spec.filters !== undefined && {
          filters: spec.filters.map((filter) => ({ ...filter })),
        }),
      };
    case 'email':
      return {
        ...base,
        ...common,
        provider: spec.provider,
        ...(spec.signingKey !== undefined && { signingKey: secretSummary(spec.signingKey) }),
        ...(spec.token !== undefined && { token: secretSummary(spec.token) }),
        ...(spec.basicAuth !== undefined && { basicAuth: { username: spec.basicAuth.username } }),
      };
    case 'slack':
      return {
        ...base,
        ...common,
        signingSecret: secretSummary(spec.signingSecret),
        ...(spec.events !== undefined && { events: [...spec.events] }),
      };
  }
}
