/**
 * @cogitator-ai/openai-compat - OpenAI Assistants API Compatibility
 *
 * This package provides:
 * - OpenAI SDK adapter: Use OpenAI SDK to interact with Cogitator
 * - REST API server: Expose Cogitator as OpenAI-compatible API
 */

export { OpenAIServer, createOpenAIServer } from './server/api-server';
export type { OpenAIServerConfig } from './server/api-server';
export { formatOpenAIError } from './server/middleware/error-handler';
export type { AuthConfig } from './server/middleware/auth';

export { OpenAIAdapter, createOpenAIAdapter, COGITATOR_MODEL_ID } from './client/openai-adapter';
export type {
  StreamEventType,
  StreamEventData,
  StreamEmitterEvents,
  RunStreamEvent,
  OpenAIAdapterOptions,
} from './client/openai-adapter';
export { ThreadManager } from './client/thread-manager';
export type {
  StoredThread,
  StoredAssistant,
  LLMThreadMessage,
  CreateAssistantParams,
  UpdateAssistantParams,
} from './client/thread-manager';

export {
  InMemoryThreadStorage,
  RedisThreadStorage,
  PostgresThreadStorage,
  createThreadStorage,
} from './client/storage';
export type {
  ThreadStorage,
  StoredFile,
  RedisThreadStorageConfig,
  PostgresThreadStorageConfig,
} from './client/storage';

export type {
  OpenAIError,
  ListResponse,
  Assistant,
  AssistantTool,
  FunctionDefinition,
  ResponseFormat,
  CreateAssistantRequest,
  UpdateAssistantRequest,
  Thread,
  ToolResources,
  CreateThreadRequest,
  Message,
  MessageContent,
  TextContent,
  TextAnnotation,
  Attachment,
  CreateMessageRequest,
  MessageContentPart,
  Run,
  RunStatus,
  RequiredAction,
  ToolCall,
  RunError,
  Usage,
  ToolChoice,
  CreateRunRequest,
  SubmitToolOutputsRequest,
  ToolOutput,
  RunStep,
  StepDetails,
  StepToolCall,
  FileObject,
  FilePurpose,
  UploadFileRequest,
  StreamEvent,
  MessageDelta,
  RunStepDelta,
  MessageContentDelta,
  ImageFileContent,
  ImageUrlContent,
  JsonSchema,
  IncompleteDetails,
  TruncationStrategy,
} from './types/openai-types';
