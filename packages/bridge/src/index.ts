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
  BridgeRouting,
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

export { bridgePaths, findCheckoutRoot, findProjectRoot } from './paths.js';
export type { BridgePaths, BridgePathsOptions } from './paths.js';

export {
  AGENT_NAME_ENV,
  AUTO_ADDRESS,
  HARNESS_ENV,
  HARNESS_SESSION_ENV,
  NEW_SESSION,
  RECIPE_HARNESS,
  SESSION_NAME_ENV,
  aliasOfHarness,
  callerFromEnv,
  autoAddressOf,
  harnessOfAlias,
  resolveAddress,
} from './registry.js';
export type { AddressResolution, ResolveAddressContext } from './registry.js';

export { renderLetter, signatureOf } from './letters.js';
export { isFinishedJobState, jobOf, jobRecordOf } from './job-record.js';
export type { BridgeLimitsInput } from './guards.js';
export { DEFAULT_VERDICT_WAIT_MS, DEFAULT_WAIT_MS, MAX_WAIT_MS } from './inputs.js';
export type {
  AcceptInput,
  AcceptResult,
  CreateJobInput,
  DiffInput,
  EscalateInput,
  ForgetInput,
  JobDiff,
  LimitedInput,
  LimitedResult,
  RecallInput,
  RejectInput,
  RememberInput,
  ResultsInput,
  InboxInput,
  PersonAnswerInput,
  SendLetterInput,
  StuckInput,
  SuggestInput,
  VerdictInput,
  VerdictResult,
  WaitEnd,
  WaitInput,
  WaitResult,
  WithdrawInput,
  WithdrawResult,
} from './inputs.js';
export { personRoutes } from './person.js';
export type {
  PersonCalls,
  PersonLetter,
  PersonNotice,
  PersonRequest,
  PersonRoute,
  RightsJudge,
  RightsQuestion,
} from './person.js';
export { inboxItemId, inboxRoute } from './person-inbox.js';
export type { PersonInbox } from './person-inbox.js';
export { channelRoute } from './person-channel.js';
export type { ChannelPersonRoute, ChannelRouteOptions } from './person-channel.js';

export { SqliteBridgeStore, BRIDGE_SCHEMA_VERSION } from './store/sqlite.js';
export type { OpenBridgeStoreOptions } from './store/sqlite.js';
export type {
  AcquireLeaseOptions,
  AcquireLeaseResult,
  AgentFilter,
  BridgeStore,
  JobTaskFilter,
  JournalQuery,
  Lease,
  LeaseCandidate,
  LetterFilter,
  LetterPatch,
} from './store/store.js';

export {
  BRIDGE_JOB_KEY,
  BRIDGE_SENDER,
  DEFAULT_JOB_TYPE,
  DEFAULT_LIMITS,
  DELIVERY_STATES,
  HARNESSES,
  HarnessNameSchema,
  INBOX_DELIVERY,
  JOB_STATES,
  JobTypeSchema,
  LETTER_KINDS,
  NO_CAPABILITIES,
  PERMISSION_ACCESSES,
  PERSON,
  PermissionAskSchema,
  VERDICTS,
} from './types.js';
export type {
  AdapterCapabilities,
  AgentRecord,
  AgentStatus,
  BridgeJob,
  BridgeJobRecord,
  BridgeLimits,
  CallerIdentity,
  DeliveryState,
  JobBudget,
  JobRecipe,
  JobChanges,
  JobCheck,
  HarnessLimit,
  JobCheckResult,
  JobFailure,
  JobRedirect,
  JobReview,
  JobState,
  JobVerification,
  JobWorktreeEnd,
  JobWorktreeRecord,
  JournalEntry,
  JournalEntryType,
  Letter,
  LetterKind,
  PermissionAccess,
  PermissionAsk,
  RenderedLetter,
  ReportOutcome,
  Rights,
  Verdict,
} from './types.js';
export type {
  BridgeAdapter,
  BridgeCalls,
  CreatedSession,
  DeliveryReceipt,
  HealthCheck,
  HealthContext,
  HealthStatus,
  IdentifyContext,
  LetterDelivery,
  LiveSession,
  PermissionHookCall,
  SessionRequest,
} from './adapter.js';

export {
  CLAUDE_DELIVERY,
  CLAUDE_SESSION_MODE,
  CLAUDE_TOOLS_PERMISSION,
  CLAUDE_TOOLS_PREFIX,
  DEFAULT_HOOK_TIMEOUT_S,
  claudeCallerCommand,
  claudePermissionCall,
  claudePermitCommand,
  claudePermitHook,
  claudeLimitCall,
  claudeLimitCommand,
  claudeLimitHook,
  claudeStuckCall,
  claudeStuckCommand,
  claudeStuckHook,
  claudeCodeAdapter,
  claudeToolCallHook,
  claudeToolsHook,
  claudeToolsScope,
  claudeTrust,
  claudeWaitCommand,
  claudeWaitHook,
  hasClaudeToolsHook,
  hasClaudeWaitHook,
} from './adapters/claude.js';
export type {
  ClaudeCodeAdapterOptions,
  ClaudeHookSettings,
  ClaudePermitHookOptions,
  ClaudePermitHookSettings,
  ClaudeStuckHookOptions,
  ClaudeStuckHookSettings,
  ClaudeToolsHookOptions,
  ClaudeToolsHookSettings,
  ClaudeTrust,
  ClaudeWaitHookOptions,
} from './adapters/claude.js';
export {
  CODEX_NOT_RESUMED_NOTE,
  CODEX_DELIVERY,
  codexAdapter,
  codexToolsServerArgs,
} from './adapters/codex.js';
export { BRIDGE_TOOLS_SERVER } from './adapters/tools-server.js';
export type { ToolsServerCommand } from './adapters/tools-server.js';
export type { CodexAdapterOptions, CodexSandbox } from './adapters/codex.js';
export {
  HOSTED_DELIVERY,
  cogitatorSessions,
  hostedAdapter,
  permissionAskOf,
  providerSessions,
} from './adapters/hosted.js';
export type {
  CogitatorSessionsOptions,
  HostedAdapterOptions,
  HostedRun,
  HostedRuntime,
  HostedSession,
  HostedSessionContext,
  HostedTurn,
  HostedTurnContext,
  OpenHostedSession,
  ProviderPermissionMode,
  ProviderSessionsOptions,
  ProviderTurn,
  TurnProvider,
} from './adapters/hosted.js';
export { CommandMissingError, shellQuote } from './adapters/exec.js';

export { claudeSetup, codexSetup } from './setup/index.js';
export type {
  AdapterSetup,
  ClaudeSetupOptions,
  CodexSetupOptions,
  InstallContext,
  SetupContext,
  SetupStep,
} from './setup/index.js';

export { mailText, waitForMail } from './waiter.js';
export { answerPermissionHook, askLeave, describeAsk } from './permit.js';
export type { AskLeaveOptions, LeaveOutcome } from './permit.js';
export type { WaitForMailOptions, WaitForMailResult } from './waiter.js';
export {
  DISCARDED_REFS,
  JOB_WORKTREES_DIR,
  type ChangeKind,
  type ChangedFile,
} from './worktree.js';
export {
  DEFAULT_RECALL_LIMIT,
  FACT_KINDS,
  MAX_FACT_LENGTH,
  MAX_RECALL_LIMIT,
  factLine,
  type BoardFact,
  type BoardQuery,
  type FactBoard,
  type FactKind,
  type FactSource,
  type NewBoardFact,
} from './board.js';
export {
  FINDING_SEVERITIES,
  FindingSchema,
  FindingsSchema,
  MAX_FINDINGS,
  atLeast,
  findingLine,
  findingsCount,
  holdsUp,
  ofTheWork,
  parseFindings,
  severitiesCount,
  type Finding,
  type FindingSeverity,
} from './findings.js';
export { limitClock, limitOf, limitOfError, limitResetOf, type LimitSignal } from './limit.js';
export {
  percent,
  resultLine,
  resultOf,
  resultRow,
  standingWords,
  standingsOf,
  suggestFrom,
  suggestionLines,
  type Candidate,
  type JobOutcome,
  type JobResult,
  type Standing,
  type StandingsOptions,
  type SuggestOptions,
  type Suggestion,
  type SuggestionBasis,
} from './scoreboard.js';
export {
  JobContextSchema,
  buildHandover,
  tokensOf,
  type ContextFile,
  type HandoverSources,
  type JobContext,
} from './handover.js';
