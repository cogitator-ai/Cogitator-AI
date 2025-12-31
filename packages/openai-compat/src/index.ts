/**
 * @cogitator-ai/openai-compat - OpenAI Assistants API Compatibility
 *
 * This package provides:
 * - OpenAI SDK adapter: Use OpenAI SDK to interact with Cogitator
 * - REST API server: Expose Cogitator as OpenAI-compatible API
 */

export { OpenAIServer, createOpenAIServer } from './server/api-server';

export { OpenAIAdapter, createOpenAIAdapter } from './client/openai-adapter';
export { ThreadManager } from './client/thread-manager';

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
} from './types/openai-types';
