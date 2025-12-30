/**
 * OpenAI API Types
 *
 * Type definitions that mirror the OpenAI Assistants API
 */


export interface OpenAIError {
  error: {
    message: string;
    type: string;
    param?: string;
    code?: string;
  };
}

export interface ListResponse<T> {
  object: 'list';
  data: T[];
  first_id?: string;
  last_id?: string;
  has_more: boolean;
}


export interface Assistant {
  id: string;
  object: 'assistant';
  created_at: number;
  name: string | null;
  description: string | null;
  model: string;
  instructions: string | null;
  tools: AssistantTool[];
  metadata: Record<string, string>;
  temperature?: number;
  top_p?: number;
  response_format?: ResponseFormat;
}

export type AssistantTool =
  | { type: 'code_interpreter' }
  | { type: 'file_search'; file_search?: { max_num_results?: number } }
  | { type: 'function'; function: FunctionDefinition };

export interface FunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export type ResponseFormat =
  | 'auto'
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: JsonSchema };

export interface JsonSchema {
  name: string;
  description?: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface CreateAssistantRequest {
  model: string;
  name?: string;
  description?: string;
  instructions?: string;
  tools?: AssistantTool[];
  metadata?: Record<string, string>;
  temperature?: number;
  top_p?: number;
  response_format?: ResponseFormat;
}

export interface UpdateAssistantRequest {
  model?: string;
  name?: string;
  description?: string;
  instructions?: string;
  tools?: AssistantTool[];
  metadata?: Record<string, string>;
  temperature?: number;
  top_p?: number;
  response_format?: ResponseFormat;
}


export interface Thread {
  id: string;
  object: 'thread';
  created_at: number;
  metadata: Record<string, string>;
  tool_resources?: ToolResources;
}

export interface ToolResources {
  code_interpreter?: {
    file_ids: string[];
  };
  file_search?: {
    vector_store_ids: string[];
  };
}

export interface CreateThreadRequest {
  messages?: CreateMessageRequest[];
  metadata?: Record<string, string>;
  tool_resources?: ToolResources;
}


export interface Message {
  id: string;
  object: 'thread.message';
  created_at: number;
  thread_id: string;
  status: 'in_progress' | 'incomplete' | 'completed';
  incomplete_details?: {
    reason: string;
  };
  completed_at: number | null;
  incomplete_at: number | null;
  role: 'user' | 'assistant';
  content: MessageContent[];
  assistant_id: string | null;
  run_id: string | null;
  attachments: Attachment[] | null;
  metadata: Record<string, string>;
}

export type MessageContent =
  | { type: 'text'; text: TextContent }
  | { type: 'image_file'; image_file: ImageFileContent }
  | { type: 'image_url'; image_url: ImageUrlContent };

export interface TextContent {
  value: string;
  annotations: TextAnnotation[];
}

export type TextAnnotation =
  | { type: 'file_citation'; text: string; file_citation: { file_id: string; quote?: string }; start_index: number; end_index: number }
  | { type: 'file_path'; text: string; file_path: { file_id: string }; start_index: number; end_index: number };

export interface ImageFileContent {
  file_id: string;
  detail?: 'auto' | 'low' | 'high';
}

export interface ImageUrlContent {
  url: string;
  detail?: 'auto' | 'low' | 'high';
}

export interface Attachment {
  file_id: string;
  tools: Array<{ type: 'code_interpreter' } | { type: 'file_search' }>;
}

export interface CreateMessageRequest {
  role: 'user' | 'assistant';
  content: string | MessageContentPart[];
  attachments?: Attachment[];
  metadata?: Record<string, string>;
}

export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
  | { type: 'image_file'; image_file: { file_id: string; detail?: 'auto' | 'low' | 'high' } };


export interface Run {
  id: string;
  object: 'thread.run';
  created_at: number;
  thread_id: string;
  assistant_id: string;
  status: RunStatus;
  required_action: RequiredAction | null;
  last_error: RunError | null;
  expires_at: number | null;
  started_at: number | null;
  cancelled_at: number | null;
  failed_at: number | null;
  completed_at: number | null;
  incomplete_details: IncompleteDetails | null;
  model: string;
  instructions: string | null;
  tools: AssistantTool[];
  metadata: Record<string, string>;
  usage: Usage | null;
  temperature?: number;
  top_p?: number;
  max_prompt_tokens?: number;
  max_completion_tokens?: number;
  truncation_strategy?: TruncationStrategy;
  response_format?: ResponseFormat;
  tool_choice?: ToolChoice;
  parallel_tool_calls?: boolean;
}

export type RunStatus =
  | 'queued'
  | 'in_progress'
  | 'requires_action'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed'
  | 'incomplete'
  | 'expired';

export interface RequiredAction {
  type: 'submit_tool_outputs';
  submit_tool_outputs: {
    tool_calls: ToolCall[];
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface RunError {
  code: 'server_error' | 'rate_limit_exceeded' | 'invalid_prompt';
  message: string;
}

export interface IncompleteDetails {
  reason: 'max_completion_tokens' | 'max_prompt_tokens';
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface TruncationStrategy {
  type: 'auto' | 'last_messages';
  last_messages?: number;
}

export type ToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface CreateRunRequest {
  assistant_id: string;
  model?: string;
  instructions?: string;
  additional_instructions?: string;
  additional_messages?: CreateMessageRequest[];
  tools?: AssistantTool[];
  metadata?: Record<string, string>;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  max_prompt_tokens?: number;
  max_completion_tokens?: number;
  truncation_strategy?: TruncationStrategy;
  tool_choice?: ToolChoice;
  parallel_tool_calls?: boolean;
  response_format?: ResponseFormat;
}

export interface SubmitToolOutputsRequest {
  tool_outputs: ToolOutput[];
  stream?: boolean;
}

export interface ToolOutput {
  tool_call_id: string;
  output: string;
}


export interface RunStep {
  id: string;
  object: 'thread.run.step';
  created_at: number;
  run_id: string;
  assistant_id: string;
  thread_id: string;
  type: 'message_creation' | 'tool_calls';
  status: 'in_progress' | 'cancelled' | 'failed' | 'completed' | 'expired';
  step_details: StepDetails;
  last_error: RunError | null;
  expired_at: number | null;
  cancelled_at: number | null;
  failed_at: number | null;
  completed_at: number | null;
  metadata: Record<string, string>;
  usage: Usage | null;
}

export type StepDetails =
  | { type: 'message_creation'; message_creation: { message_id: string } }
  | { type: 'tool_calls'; tool_calls: StepToolCall[] };

export type StepToolCall =
  | { id: string; type: 'code_interpreter'; code_interpreter: CodeInterpreterCall }
  | { id: string; type: 'file_search'; file_search: FileSearchCall }
  | { id: string; type: 'function'; function: FunctionCall };

export interface CodeInterpreterCall {
  input: string;
  outputs: CodeInterpreterOutput[];
}

export type CodeInterpreterOutput =
  | { type: 'logs'; logs: string }
  | { type: 'image'; image: { file_id: string } };

export interface FileSearchCall {
  ranking_options?: {
    ranker: string;
    score_threshold: number;
  };
  results?: FileSearchResult[];
}

export interface FileSearchResult {
  file_id: string;
  file_name: string;
  score: number;
  content?: { type: 'text'; text: string }[];
}

export interface FunctionCall {
  name: string;
  arguments: string;
  output: string | null;
}


export interface FileObject {
  id: string;
  object: 'file';
  bytes: number;
  created_at: number;
  filename: string;
  purpose: FilePurpose;
  status?: 'uploaded' | 'processed' | 'error';
  status_details?: string;
}

export type FilePurpose =
  | 'assistants'
  | 'assistants_output'
  | 'batch'
  | 'batch_output'
  | 'fine-tune'
  | 'fine-tune-results'
  | 'vision';

export interface UploadFileRequest {
  file: Buffer | Blob;
  purpose: FilePurpose;
  filename?: string;
}


export type StreamEvent =
  | { event: 'thread.created'; data: Thread }
  | { event: 'thread.run.created'; data: Run }
  | { event: 'thread.run.queued'; data: Run }
  | { event: 'thread.run.in_progress'; data: Run }
  | { event: 'thread.run.requires_action'; data: Run }
  | { event: 'thread.run.completed'; data: Run }
  | { event: 'thread.run.incomplete'; data: Run }
  | { event: 'thread.run.failed'; data: Run }
  | { event: 'thread.run.cancelling'; data: Run }
  | { event: 'thread.run.cancelled'; data: Run }
  | { event: 'thread.run.expired'; data: Run }
  | { event: 'thread.run.step.created'; data: RunStep }
  | { event: 'thread.run.step.in_progress'; data: RunStep }
  | { event: 'thread.run.step.delta'; data: RunStepDelta }
  | { event: 'thread.run.step.completed'; data: RunStep }
  | { event: 'thread.run.step.failed'; data: RunStep }
  | { event: 'thread.run.step.cancelled'; data: RunStep }
  | { event: 'thread.run.step.expired'; data: RunStep }
  | { event: 'thread.message.created'; data: Message }
  | { event: 'thread.message.in_progress'; data: Message }
  | { event: 'thread.message.delta'; data: MessageDelta }
  | { event: 'thread.message.completed'; data: Message }
  | { event: 'thread.message.incomplete'; data: Message }
  | { event: 'error'; data: OpenAIError }
  | { event: 'done'; data: '[DONE]' };

export interface RunStepDelta {
  id: string;
  object: 'thread.run.step.delta';
  delta: {
    step_details?: Partial<StepDetails>;
  };
}

export interface MessageDelta {
  id: string;
  object: 'thread.message.delta';
  delta: {
    role?: 'user' | 'assistant';
    content?: MessageContentDelta[];
  };
}

export type MessageContentDelta =
  | { index: number; type: 'text'; text?: { value?: string; annotations?: TextAnnotation[] } }
  | { index: number; type: 'image_file'; image_file?: { file_id?: string } }
  | { index: number; type: 'image_url'; image_url?: { url?: string } };

