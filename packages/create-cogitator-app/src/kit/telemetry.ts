import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { constantCase } from './errors.js';
import type { StepResult } from './scaffold.js';
import type { ProjectSpec } from './spec.js';
import { scaffolderVersion } from './versions.js';

declare const __TELEMETRY_WEBSITE_ID__: string | undefined;

/** Where the events go: the Umami instance of the Cogitator project. */
export const TELEMETRY_HOST = 'https://analytics.el1fe.com';
export const TELEMETRY_DOCS = 'https://cogitator.app/docs/getting-started/telemetry';
const SEND_TIMEOUT_MS = 1500;

/**
 * The Umami website the events are counted under, set when the scaffolder is
 * built for a release (`COGITATOR_UMAMI_WEBSITE_ID`). A build without it sends
 * nothing.
 */
export function telemetryWebsiteId(): string {
  return typeof __TELEMETRY_WEBSITE_ID__ === 'undefined' ? '' : __TELEMETRY_WEBSITE_ID__;
}

/**
 * Everything one event carries, and nothing else: no project name, path,
 * model, key or anything a user typed.
 */
export interface TelemetryPayload {
  version: string;
  /** The preset, `custom` for a stack picked by hand, `example` or `template` for copied projects. */
  preset: string;
  provider: string;
  memory: string;
  /** The add-ons, comma-separated in catalog order. */
  features: string;
  packageManager: string;
  /** The major version of Node, such as `24`. */
  node: string;
  /** `darwin`, `linux` or `win32`. */
  os: string;
  outcome: 'success' | 'failure';
  /** Where a failure stopped, `none` on success. */
  failedStep: FailedStep | 'none';
  /**
   * Why it stopped, as a code such as `ERR_PNPM_NO_MATCHING_VERSION`,
   * `ENOTFOUND` or `HTTP_404` (see `telemetryErrorCode`), `none` on success.
   */
  errorCode: string;
}

/**
 * Where a scaffold failed: `create` while making the project (its options,
 * the directory, writing or downloading files), `install` while installing
 * its dependencies.
 */
export type FailedStep = 'create' | 'install';

/** A failed scaffold: the step it stopped at and the error it stopped with. */
export interface ScaffoldFailure {
  step: FailedStep;
  error: unknown;
}

export const PAYLOAD_FIELDS: ReadonlyArray<keyof TelemetryPayload> = [
  'version',
  'preset',
  'provider',
  'memory',
  'features',
  'packageManager',
  'node',
  'os',
  'outcome',
  'failedStep',
  'errorCode',
];

const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * A code for why `error` happened that is safe to send: the `code` of the
 * error or of one of its causes (Node's `ENOTFOUND`, a package manager's
 * `ERR_PNPM_NO_MATCHING_VERSION`, the scaffolder's own `HTTP_404` or
 * `DIRECTORY_NOT_EMPTY`), else the kind of error (`TYPE_ERROR`), else
 * `UNKNOWN`. Never the message, which can hold paths and names.
 */
export function telemetryErrorCode(error: unknown): string {
  let kind: string | undefined;
  let current = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    if ('code' in current && typeof current.code === 'string' && SAFE_CODE.test(current.code))
      return current.code;
    if (
      !kind &&
      current instanceof Error &&
      current.name !== 'Error' &&
      /^[A-Za-z]+$/.test(current.name)
    )
      kind = constantCase(current.name);
    current = 'cause' in current ? current.cause : undefined;
  }
  return kind ?? 'UNKNOWN';
}

/** The failure of a scaffold whose install step failed, `undefined` when it did not. */
export function installFailure(result: { install: StepResult }): ScaffoldFailure | undefined {
  return result.install.status === 'failed'
    ? { step: 'install', error: result.install.error }
    : undefined;
}

/** The event of a scaffold of `spec`: failed with `failure`, successful without one. */
export function payloadFor(
  spec:
    Pick<ProjectSpec, 'preset' | 'provider' | 'memory' | 'features' | 'packageManager'> | undefined,
  failure?: ScaffoldFailure,
  kind: 'generated' | 'example' | 'template' = 'generated'
): TelemetryPayload {
  return {
    version: scaffolderVersion(),
    preset: kind !== 'generated' ? kind : (spec?.preset ?? 'custom'),
    provider: spec?.provider ?? 'none',
    memory: spec?.memory ?? 'none',
    features: spec?.features.join(',') ?? '',
    packageManager: spec?.packageManager ?? 'unknown',
    node: process.versions.node.split('.')[0],
    os: process.platform,
    outcome: failure ? 'failure' : 'success',
    failedStep: failure?.step ?? 'none',
    errorCode: failure ? telemetryErrorCode(failure.error) : 'none',
  };
}

/** Why no event is sent, or `undefined` when one is. */
export function telemetryDisabledReason(options: {
  flag?: boolean;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  websiteId?: string;
}): string | undefined {
  const env = options.env ?? process.env;
  const on = (value: string | undefined) => {
    const normalized = value?.trim().toLowerCase();
    return (
      normalized !== undefined && normalized !== '' && normalized !== '0' && normalized !== 'false'
    );
  };
  if (options.flag === false) return '--no-telemetry';
  if (on(env.COGITATOR_TELEMETRY_DISABLED)) return 'COGITATOR_TELEMETRY_DISABLED';
  if (on(env.DO_NOT_TRACK)) return 'DO_NOT_TRACK';
  if (on(env.CI)) return 'CI';
  if (options.dryRun) return '--dry-run';
  if (!(options.websiteId ?? telemetryWebsiteId())) return 'this build has no telemetry configured';
  return undefined;
}

function configDir(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'cogitator');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cogitator');
}

/**
 * The one line about telemetry shown the first time it is on, or `undefined`
 * when it was shown before. Showing it is remembered in the user's config
 * directory.
 */
export function firstRunNotice(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const marker = join(configDir(env), 'telemetry-notice');
  if (existsSync(marker)) return undefined;
  try {
    mkdirSync(configDir(env), { recursive: true });
    writeFileSync(marker, `${new Date().toISOString()}\n`);
  } catch {
    return undefined;
  }
  return `Cogitator sends one anonymous event per scaffolded project (version, preset, provider, memory, add-ons, package manager, Node major, OS, and where and why it failed if it did). Turn it off with --no-telemetry or COGITATOR_TELEMETRY_DISABLED=1: ${TELEMETRY_DOCS}`;
}

/** How browsers name each platform, which is what Umami reads the OS from. */
const UA_PLATFORMS: Record<string, string> = {
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  linux: 'X11; Linux x86_64',
  win32: 'Windows NT 10.0; Win64; x64',
};

/**
 * The User-Agent of an event. Umami silently drops requests its bot filter
 * (`isbot`) recognizes, and a `Node/` token is one of them, so the Node version
 * travels in the payload only.
 */
export function telemetryUserAgent(payload: Pick<TelemetryPayload, 'os' | 'version'>): string {
  return `Mozilla/5.0 (${UA_PLATFORMS[payload.os] ?? payload.os}) create-cogitator-app/${payload.version}`;
}

/**
 * Sends the event to Umami. It never throws and never takes longer than its
 * timeout: a slow or failing network changes nothing for the scaffolder.
 */
export async function sendTelemetry(
  payload: TelemetryPayload,
  options: { fetch?: typeof fetch; websiteId?: string; host?: string; timeoutMs?: number } = {}
): Promise<boolean> {
  const website = options.websiteId ?? telemetryWebsiteId();
  if (!website) return false;
  const body = {
    type: 'event',
    payload: {
      website,
      hostname: 'create-cogitator-app',
      url: `/scaffold/${payload.preset}`,
      name: 'scaffold',
      data: payload,
    },
  };
  try {
    const response = await (options.fetch ?? fetch)(`${options.host ?? TELEMETRY_HOST}/api/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': telemetryUserAgent(payload),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? SEND_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
