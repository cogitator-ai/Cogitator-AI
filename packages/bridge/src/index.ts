/**
 * The agent bridge: Claude Code, Codex and other agents hand each other jobs, ask questions on
 * the way and report back, each staying in its own window. Experimental.
 *
 * @example
 * ```ts
 * import { BridgeClient, bridgePaths, callerFromEnv } from '@cogitator-ai/bridge';
 *
 * const caller = callerFromEnv(process.env, process.cwd());
 * const bridge = await BridgeClient.connect({ socketPath: bridgePaths().socket, caller });
 * const { job } = await bridge.createJob({ to: 'codex', body: 'Write the tests' });
 * ```
 */
export { BridgeDispatcher } from './dispatcher.js';
export type {
  BridgeDispatcherEvents,
  BridgeDispatcherOptions,
  CreateJobResult,
  DispatcherStatus,
  SendLetterResult,
  SweepResult,
} from './dispatcher.js';

export { BridgeClient } from './client.js';
export type { BridgeClientOptions } from './client.js';

export { hostBridge, bridgeVersion } from './host.js';
export type { BridgeHost, BridgeStopReason, HostBridgeOptions } from './host.js';

export { serveBridge } from './server.js';
export type { BridgeServer, BridgeServerOptions } from './server.js';

export {
  BRIDGE_ERROR_CODE,
  BRIDGE_METHODS,
  BRIDGE_NOTIFICATIONS,
  BRIDGE_PROTOCOL_VERSION,
} from './protocol.js';
export type { BridgeStatus, DispatcherInfo, HelloResult } from './protocol.js';

export { BridgeError, isBridgeError } from './errors.js';
export type { BridgeErrorCode } from './errors.js';

export { bridgePaths, findProjectRoot } from './paths.js';
export type { BridgePaths, BridgePathsOptions } from './paths.js';

export {
  AGENT_NAME_ENV,
  HARNESS_ENV,
  HARNESS_SESSION_ENV,
  NEW_SESSION,
  SESSION_NAME_ENV,
  aliasOfHarness,
  callerFromEnv,
  harnessOfAlias,
  resolveAddress,
} from './registry.js';
export type { AddressResolution, ResolveAddressContext } from './registry.js';

export { renderLetter, signatureOf } from './letters.js';
export { isFinishedJobState, jobOf, jobRecordOf } from './job-record.js';
export type { BridgeLimitsInput } from './guards.js';
export type { CreateJobInput, InboxInput, SendLetterInput } from './inputs.js';

export { SqliteBridgeStore, BRIDGE_SCHEMA_VERSION } from './store/sqlite.js';
export type { OpenBridgeStoreOptions } from './store/sqlite.js';
export type {
  AgentFilter,
  BridgeStore,
  JobTaskFilter,
  JournalQuery,
  Lease,
  LetterFilter,
} from './store/store.js';

export {
  BRIDGE_JOB_KEY,
  BRIDGE_SENDER,
  DEFAULT_LIMITS,
  DELIVERY_STATES,
  HARNESSES,
  INBOX_DELIVERY,
  JOB_STATES,
  LETTER_KINDS,
  NO_CAPABILITIES,
} from './types.js';
export type {
  AdapterCapabilities,
  AgentRecord,
  AgentStatus,
  BridgeAdapter,
  BridgeJob,
  BridgeJobRecord,
  BridgeLimits,
  CallerIdentity,
  CreatedSession,
  DeliveryState,
  JobBudget,
  JobCheck,
  JobState,
  JobVerification,
  JournalEntry,
  JournalEntryType,
  Letter,
  LetterDelivery,
  LetterKind,
  RenderedLetter,
  ReportOutcome,
  SessionRequest,
} from './types.js';
