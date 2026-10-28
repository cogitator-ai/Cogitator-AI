# @cogitator-ai/mcp

MCP (Model Context Protocol) integration for Cogitator. Connect to external MCP servers, expose Cogitator tools as an MCP server, or serve whole agents to Claude Desktop, Cursor and any other MCP client.

Full guide: [cogitator.app/docs/integrations/mcp](https://cogitator.app/docs/integrations/mcp)

## Installation

```bash
pnpm add @cogitator-ai/mcp
```

The examples below also use `@cogitator-ai/core` (agents, `tool()`) and `zod`:

```bash
pnpm add @cogitator-ai/core zod
```

## Features

- **Protocol 2026-07-28 and 2025-11-25** - The client asks a server with `server/discover` and speaks the new stateless revision to servers that do, `initialize` to older ones. The server serves both
- **MCP Client** - Connect to any MCP server over stdio or Streamable HTTP
- **MCP Server** - Expose Cogitator tools, resources and prompts over stdio or Streamable HTTP
- **Serve Agents** - Turn Cogitator agents into MCP tools in one call, with tool approvals through MCP elicitation
- **Multi round-trip requests** - Approvals and questions end a round with the questions and a signed state, the client calls again with the answers. An agent run that asks pauses, and resumes with them
- **Tasks** - Long calls become MCP tasks the client polls, answers and cancels (extension `io.modelcontextprotocol/tasks`)
- **OAuth 2.1** - Client ID Metadata Documents, Dynamic Client Registration as a fallback, `iss` checked, Protected Resource Metadata on the server
- **Subscriptions** - Hear of tool, prompt and resource changes through `subscriptions/listen`
- **Auth & Sessions** - Per-request `auth` for HTTP servers, the caller's `userId` reaches tools; optional per-client sessions for 2025-11-25 clients
- **Elicitation** - Tools served over MCP can ask the person at the client a question while the call waits
- **Tool Adapters** - Bidirectional conversion between Cogitator and MCP formats
- **Schema Converters** - Convert between Zod and JSON Schema
- **Resources & Prompts** - Access MCP resources and prompt templates
- **Retry & Recovery** - Automatic retry with exponential backoff and reconnection handling

---

## Quick Start

### Use Tools from an MCP Server

```typescript
import { MCPClient } from '@cogitator-ai/mcp';
import { Agent, Cogitator } from '@cogitator-ai/core';

const client = await MCPClient.connect({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/allowed/path'],
});

const tools = await client.getTools();

const agent = new Agent({
  name: 'File Agent',
  model: 'ollama/llama3.1:8b',
  instructions: 'You can read and write files.',
  tools,
});

const cog = new Cogitator();
const result = await cog.run(agent, {
  input: 'List files in /allowed/path',
});

await client.close();
await cog.close();
```

### Expose Cogitator Tools as MCP Server

```typescript
import { MCPServer } from '@cogitator-ai/mcp';
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const calculator = tool({
  name: 'calculator',
  description: 'Perform math calculations',
  parameters: z.object({
    expression: z.string().describe('Math expression'),
  }),
  execute: async ({ expression }) => {
    return String(eval(expression));
  },
});

const server = new MCPServer({
  name: 'my-tools',
  version: '1.0.0',
  transport: 'stdio',
});

server.registerTool(calculator);
await server.start();
```

---

## MCP Client

Connect to external MCP servers and use their tools with Cogitator agents.

### Connection Options

```typescript
import { MCPClient } from '@cogitator-ai/mcp';

const client = await MCPClient.connect({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/path'],
  env: { DEBUG: 'true' },
  timeout: 30000,
  clientName: 'my-app',
  clientVersion: '1.0.0',
});
```

### Configuration

```typescript
interface MCPClientConfig {
  transport: 'stdio' | 'http' | 'sse';

  // For stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>; // merged over the parent's environment
  cwd?: string; // working directory of the spawned command

  // For HTTP transport
  url?: string;
  headers?: Record<string, string>; // sent with every request, e.g. Authorization

  // Connection options
  timeout?: number; // connection timeout in ms
  clientName?: string;
  clientVersion?: string;

  // Protocol 2026-07-28
  protocol?: 'auto' | 'legacy' | { pin: string }; // Default: 'auto'
  elicitation?: false | MCPElicitationHandler; // answers input requests no run can answer
  tasks?: boolean | { store?: MCPClientTaskStore; maxPollIntervalMs?: number }; // Default: true
  auth?: OAuthClientProvider | MCPOAuthConfig; // OAuth for a remote server
  maxInputRounds?: number; // Default: 10

  // Retry configuration
  retry?: MCPRetryConfig;
  autoReconnect?: boolean; // Default: true

  // Reconnection callbacks
  onReconnecting?: (attempt: number) => void;
  onReconnected?: () => void;
  onReconnectFailed?: (error: Error) => void;
}
```

### Retry & Recovery

The MCP client includes automatic retry and reconnection handling for resilient connections.

```typescript
const client = await MCPClient.connect({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/path'],

  retry: {
    maxRetries: 5,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 2,
    retryOnConnectionLoss: true,
  },

  autoReconnect: true,
  onReconnecting: (attempt) => console.log(`Reconnecting... attempt ${attempt}`),
  onReconnected: () => console.log('Reconnected successfully'),
  onReconnectFailed: (error) => console.error('Failed to reconnect:', error),
});
```

#### Retry Configuration

```typescript
interface MCPRetryConfig {
  maxRetries?: number; // Default: 3
  initialDelay?: number; // Default: 1000ms
  maxDelay?: number; // Default: 30000ms
  backoffMultiplier?: number; // Default: 2
  retryOnConnectionLoss?: boolean; // Default: true
}
```

#### Automatic Retry Behavior

Requests that are safe to send twice (`listToolDefinitions`, `listResources`, `readResource`, `readResourceContents`, `listPrompts`, `getPrompt`) automatically retry on transient failures:

- Connection errors (ECONNREFUSED, ECONNRESET, closed connections)
- Request timeouts
- Network failures

A tool call is different: after a timeout or a lost connection the server may still be running it, or may have finished it, and a second call could deploy twice or send a second email. So `callTool` sends a call once and throws `MCPToolInterruptedError` (`reason: 'timeout' | 'connection-lost'`) instead of retrying, unless the call is marked `idempotent: true`. Tools from `getTools()` / `wrapMCPTools()` set `idempotent` from the server's tool annotations: a tool with `readOnlyHint` or `idempotentHint` is retried like a read, any other is not. A connection lost by an earlier call is restored before the next call is sent.

Deterministic failures are **not** retried: JSON-RPC protocol errors from the server (invalid params, unknown tool, internal handler errors), tool results with `isError: true`, and calls whose `signal` was aborted fail immediately.

When a connection error is detected on a retried request (with `autoReconnect` and `retryOnConnectionLoss` on, the defaults), the client will:

1. Close the existing connection
2. Create a new transport and client
3. Reconnect, up to `maxRetries` attempts with exponential backoff between them
4. Continue the operation on the new connection

Other transient failures are retried with the same backoff, without reconnecting. After `close()` the client never reconnects.

Concurrent operations that lose the connection at the same time share a single reconnection.

#### Manual Reconnection

```typescript
if (!client.isConnected()) {
  await client.reconnect();
}
```

### Transport Types

| Transport    | Use Case                                             |
| ------------ | ---------------------------------------------------- |
| `stdio`      | Local MCP servers spawned as child processes         |
| `http`       | Remote MCP servers over Streamable HTTP              |
| `sse`        | Alias of `http` (also Streamable HTTP)               |
| `legacy-sse` | Servers of the older HTTP+SSE protocol (client only) |

`sse` connects with Streamable HTTP, which streams responses over SSE itself, as the server's `sse` serves it. A server of the older HTTP+SSE protocol, which opens its event stream with a GET and takes messages in POSTs to the endpoint it names, needs `legacy-sse`: `experimental_mcpConnector()` uses it for `type: "sse"` of a `.mcp.json`, as Claude Code does.

`createStdioTransport()`, `createHttpTransport()` and `createSseTransport()` build the same SDK transports the client uses, if you drive `@modelcontextprotocol/client`'s `Client` directly.

### Protocol Versions

MCP 2026-07-28 has no `initialize` handshake: every request carries its protocol version and the client's capabilities in `_meta`, and a server describes itself through `server/discover`. With `protocol: 'auto'` (the default) the client sends `server/discover` first and speaks 2026-07-28 to a server that answers, and 2025-11-25 (`initialize`) to any other. On stdio the MCP SDK probes in a short-lived copy of the server process, so a stdio server starts twice on the first connect. A reconnect reuses what the first connect found and asks nothing.

```typescript
const client = await MCPClient.connect({ transport: 'http', url });
client.era; // 'modern' or 'legacy'
client.protocolVersion; // '2026-07-28'
client.discover(); // { protocolVersion, era, supportedVersions, capabilities, instructions, serverInfo }
```

`protocol: 'legacy'` keeps the behavior of earlier versions of this package: no probe, always 2025-11-25. `protocol: { pin: '2026-07-28' }` speaks only that revision and fails against older servers.

### Input Requests (Elicitation)

A server of 2026-07-28 asks the person at the client by answering a call with input requests (`resultType: "input_required"`), and the client calls again with the answers and the server's `requestState`. A tool from `getTools()` asks through the run of the call: the run pauses with an interrupt (`reason: 'mcp_elicitation'`, its `responseSchema` the server's form), `cogitator.resume()` with the answer runs the tool again, and the call goes on. Ending the pause without an answer (`cog.cancelPause()`) declines. Outside a run, the `elicitation` handler answers, and without one the client does not declare elicitation, so the server knows nobody can answer.

```typescript
const client = await MCPClient.connect({
  transport: 'http',
  url,
  elicitation: async (request, { server, tool }) =>
    request.mode === 'url'
      ? { action: 'decline' }
      : { action: 'accept', content: await askSomeone(request.message, request.schema) },
});
```

The handler also answers the `elicitation/create` requests of 2025-11-25 servers. `elicitation: false` tells servers the client cannot answer at all.

### Tasks

A server that supports MCP tasks may answer a long call with a task. The client polls it (`tasks/get`, at the interval the server suggests), answers its input requests (`tasks/update`), reports its status message through the tool's `update`, and cancels it (`tasks/cancel`) when the call's signal aborts. A task survives a lost connection: polling goes on after the reconnect. Tasks are kept by tool call id, so a call that runs again after its run paused on a question polls the task it started instead of starting another. `tasks: { store }` keeps them elsewhere, `tasks: false` turns tasks off.

### OAuth

```typescript
import { MCPClient, InMemoryMCPOAuthStore } from '@cogitator-ai/mcp';

const client = await MCPClient.connect({
  transport: 'http',
  url: 'https://mcp.example.com/mcp',
  auth: {
    redirectUrl: 'http://127.0.0.1:8976/callback',
    clientMetadataUrl: 'https://my-app.example.com/oauth/client.json',
    store: new InMemoryMCPOAuthStore(),
    authorize: async (url) => openBrowserAndWaitForCallback(url),
  },
});
```

On a 401 the client finds the authorization server through the server's Protected Resource Metadata, registers, sends the person to `authorize` with PKCE and the `resource` of the server, checks the `iss` of the answer against the authorization server, and connects again with the token. It registers with `clientId` when you give one, else with its Client ID Metadata Document (`clientMetadataUrl`, an HTTPS URL of a JSON document you host, with `client_id`, `client_name` and `redirect_uris`) when the authorization server supports those, else by Dynamic Client Registration (`application_type: "native"` for a loopback redirect). Registrations and tokens are kept per authorization server. `createMCPOAuthProvider()` builds the provider on its own, and `auth` also takes an `OAuthClientProvider` of the MCP SDK.

### Subscriptions

```typescript
const subscription = await client.subscribe(
  { toolsListChanged: true, resourceSubscriptions: ['notes://today'] },
  { onToolsChanged: () => refreshTools(), onResourceUpdated: (uri) => reload(uri) }
);
subscription.filter; // what the server agreed to report
await subscription.close();
```

On 2026-07-28 this opens a `subscriptions/listen` stream, on earlier revisions resources are subscribed one by one and list changes come as the server sends them.

### Client Methods

```typescript
const client = await MCPClient.connect(config);

client.isConnected();

client.isReconnecting();

client.getCapabilities();

await client.reconnect();

const definitions = await client.listToolDefinitions();

const tools = await client.getTools();

const result = await client.callTool('tool_name', { arg: 'value' });

const controller = new AbortController();
await client.callTool('slow_tool', {}, { signal: controller.signal, timeout: 10_000 });

await client.callTool('get_status', {}, { idempotent: true });

const resources = await client.listResources();

const content = await client.readResource('file://path/to/file');

const allParts = await client.readResourceContents('file://path/to/dir');

const prompts = await client.listPrompts();

const messages = await client.getPrompt('prompt_name', { arg: 'value' });

await client.close();
```

### Tool Results and Errors

`callTool` returns the server's `structuredContent` when present (any JSON value, such as an array, since 2026-07-28), otherwise text blocks are unwrapped: JSON-parsed when possible, a single block's value on its own, several as an array, and an empty result is `null`. Content with images, audio or binary resources comes back as a `toolContent()` result of `@cogitator-ai/core` (images as `image` parts, audio and blobs as `file` parts, text resources as `resource` parts that keep their URI), so an agent's model sees a screenshot as an image instead of base64 text, and audio stays out of the context. A link to a resource becomes a line of text.

When the server reports a tool failure (`isError: true`), `callTool` throws an `MCPToolError` carrying the tool name and the original content blocks. Tools produced by `getTools()` / `wrapMCPTools()` therefore surface MCP tool failures as regular Cogitator tool errors, and they forward the run's abort signal to the server.

```typescript
import { MCPToolError } from '@cogitator-ai/mcp';

try {
  await client.callTool('delete_file', { path: '/protected' });
} catch (error) {
  if (error instanceof MCPToolError) {
    console.error(error.toolName, error.message, error.content);
  }
}
```

### Helper Function

For quick one-liner connections:

```typescript
import { connectMCPServer } from '@cogitator-ai/mcp';
import { Agent } from '@cogitator-ai/core';

const { tools, client, cleanup } = await connectMCPServer({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/path'],
});

const agent = new Agent({
  name: 'files',
  model: 'ollama/llama3.2',
  instructions: 'You manage files.',
  tools,
});

// When done
await cleanup();
```

---

### Servers of plugins and subagents

`experimental_mcpConnector()` connects MCP servers given as `.mcp.json` writes them: `command`, `args`, `env` and `cwd` for stdio, `url` (with `type: 'sse'` for SSE) and `headers` for HTTP. Pass it as `experimental_plugins.mcp` for the servers of [plugins](https://cogitator.app/docs/core/plugins), or as `subagents.mcp` for the inline servers of subagents. Each server's tools are named `mcp__<server>__<tool>` and carry their server in `mcp`, so a plugin server `plugin:deploy:api` gives `mcp__plugin_deploy_api__<tool>`, as in Claude Code, and permission rules and hook matchers name them that way.

```typescript
import { Cogitator } from '@cogitator-ai/core';
import { experimental_mcpConnector } from '@cogitator-ai/mcp';

const mcp = experimental_mcpConnector({ timeout: 20_000 });
const cog = new Cogitator({
  experimental_plugins: { dirs: ['./plugins/deploy'], mcp },
  subagents: { files: true, mcp },
});
```

`cogitator run` adds the connector by itself when its config has `experimental_plugins`.

## MCP Server

Expose Cogitator tools as an MCP server for use by Claude Desktop, other AI assistants, or any MCP client.

### Creating a Server

```typescript
import { MCPServer } from '@cogitator-ai/mcp';

const server = new MCPServer({
  name: 'my-cogitator-server',
  version: '1.0.0',
  transport: 'stdio',
  logging: true,
});

server.registerTool(tool1);
server.registerTool(tool2);
// or
server.registerTools([tool1, tool2, tool3]);

await server.start();
```

### Server Configuration

```typescript
interface MCPServerConfig {
  name: string;
  version: string;
  transport: 'stdio' | 'http' | 'sse';

  // For HTTP transport
  port?: number; // Default: 3000 (use 0 for a random free port)
  host?: string; // Default: 'localhost'
  maxBodySize?: number; // Default: 10 MB, larger bodies get 413
  corsOrigin?: string; // Default: '*'
  auth?: MCPAuthFunction; // Establishes the caller; undefined → 401
  sessions?: boolean; // Session per client (needed for elicitation); default: off

  elicitationTimeoutMs?: number; // How long an elicitation waits for the user; default: 600000, 0 for as long as the call lasts

  logging?: boolean; // Diagnostic logging to stderr (stdout stays clean for stdio JSON-RPC)

  toolInvoker?: ToolInvoker; // Runs tool calls, e.g. your Cogitator; default: one of its own
}
```

Tool calls run the way an agent run executes them, through a `ToolInvoker` (`cogitator.invokeTool()`): the arguments are validated, a tool with `requiresApproval` (or one the guardrails flag) is asked from the person at the client through MCP elicitation, the guardrails apply, sandboxed tools run in the sandbox and `tool.timeout` holds. Pass your `Cogitator` as `toolInvoker` so its sandbox and guardrails are the ones used, otherwise the server uses a Cogitator of its own without configuration. A call that needs approval when nobody can be asked (a client without elicitation, or HTTP without `sessions: true`) does not run: it comes back as an `isError` result that says so, unless the invoker's `guardrails.onToolApproval` decides it.

Tool arguments are validated once, by the MCP SDK against the tool's full Zod schema (including refinements, transforms and object modifiers such as `z.looseObject`). Invalid arguments and thrown errors are returned to the client as `isError` tool results. Errors thrown by resource `read` and prompt `get` handlers are returned as JSON-RPC errors.

### Server Methods

```typescript
const server = new MCPServer(config);

// Tools
server.registerTool(tool);
server.registerTools([tool1, tool2]);
server.unregisterTool('tool_name'); // only before start()
server.getRegisteredTools();

// Resources
server.registerResource(resourceConfig);
server.registerResources([resource1, resource2]);
server.unregisterResource('memory://threads'); // only before start()
server.getRegisteredResources();

// Prompts
server.registerPrompt(promptConfig);
server.registerPrompts([prompt1, prompt2]);
server.unregisterPrompt('summarize'); // only before start()
server.getRegisteredPrompts();

// Lifecycle
await server.start(); // rejects if the HTTP port cannot be bound
server.isRunning();
server.getPort(); // bound HTTP port, useful with port: 0
await server.stop(); // also closes open HTTP connections
```

### Tool Titles, Hints and Output Schemas

A tool's `title`, `annotations` and `outputSchema` reach MCP clients with the tool. Clients show the title to people, read the hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) to decide how careful to be, and get the result of a tool with an output schema as `structuredContent`, with its JSON as text for clients that read only `content`. A result the output schema rejects comes back as a tool error that says why. Since 2026-07-28 an output schema may have any root (an array, a record, a union, a number) and `structuredContent` may be any JSON value. Clients of 2025-11-25 need an object, so the MCP SDK sends them a result of another shape wrapped as `{ result }`, its schema wrapped the same way.

Imported tools (`getTools()`) keep the server's output schema, and their `toJSON()` carries it to the model: Gemini gets it as the function's `responseJsonSchema`. Other providers have no field for it, `llm.toolOutputSchemas: 'description'` of `Cogitator` adds it to the end of the tool's description for them.

```typescript
const getRepo = tool({
  name: 'get_repo',
  title: 'Repository details',
  description: 'Get the details of a repository',
  parameters: z.object({ repo: z.string() }),
  outputSchema: z.object({ repo: z.string(), stars: z.number() }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  execute: async ({ repo }) => ({ repo, stars: 42 }),
});
server.registerTool(getRepo);
```

### Registering Resources

Expose data to MCP clients via resources. Supports both static URIs and dynamic URI templates (`{name}` placeholders, passed to `read` as params). `read` may leave out `uri` — it defaults to the URI that was read — and may return several contents as an array.

```typescript
const server = new MCPServer({
  name: 'memory-server',
  version: '1.0.0',
  transport: 'stdio',
});

// Static resource with fixed URI
server.registerResource({
  uri: 'memory://threads',
  name: 'Conversation Threads',
  description: 'List of all conversation threads',
  mimeType: 'application/json',
  read: async () => ({
    text: JSON.stringify(await getAllThreads()),
  }),
});

// Dynamic resource with URI template
server.registerResource({
  uri: 'memory://thread/{id}',
  name: 'Thread Content',
  description: 'Content of a specific thread',
  mimeType: 'application/json',
  read: async ({ id }) => ({
    text: JSON.stringify(await getThread(id)),
  }),
});

// Resource returning binary data
server.registerResource({
  uri: 'files://avatar/{userId}',
  name: 'User Avatar',
  mimeType: 'image/png',
  read: async ({ userId }) => ({
    blob: await getAvatarBase64(userId),
  }),
});
```

### Registering Prompts

Expose reusable prompt templates to MCP clients.

```typescript
const server = new MCPServer({
  name: 'prompt-server',
  version: '1.0.0',
  transport: 'stdio',
});

// Simple prompt
server.registerPrompt({
  name: 'summarize',
  title: 'Summarize Content',
  description: 'Generate a summary of the provided content',
  arguments: [
    { name: 'content', description: 'Content to summarize', required: true },
    { name: 'style', description: 'Summary style (brief/detailed)', required: false },
  ],
  get: async ({ content, style = 'brief' }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Please provide a ${style} summary of:\n\n${content}`,
        },
      },
    ],
  }),
});

// Code review prompt
server.registerPrompt({
  name: 'review-code',
  title: 'Code Review',
  description: 'Review code for issues and improvements',
  arguments: [
    { name: 'code', description: 'Code to review', required: true },
    { name: 'language', description: 'Programming language', required: false },
  ],
  get: async ({ code, language }) => ({
    description: `Reviewing ${language || 'code'}`,
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Review this ${language || ''} code for best practices and issues:\n\n\`\`\`${language || ''}\n${code}\n\`\`\``,
        },
      },
    ],
  }),
});
```

### Resource Configuration

```typescript
interface MCPResourceConfig {
  uri: string; // Static URI or template like 'memory://thread/{id}'
  name: string;
  description?: string;
  mimeType?: string; // Used for contents that set no mimeType of their own
  read: (
    params: Record<string, string>, // Template variables; {} for a static URI
    caller?: MCPCaller // Who `auth` established, on the HTTP transport
  ) => Promise<MCPResourceReadContent | MCPResourceReadContent[]>;
}

// What `read` returns: `uri` may be left out and defaults to the URI that was read
interface MCPResourceReadContent {
  uri?: string;
  mimeType?: string;
  text?: string; // Text content
  blob?: string; // Base64 encoded binary (wins over `text` when both are set)
}
```

### Prompt Configuration

```typescript
interface MCPPromptConfig {
  name: string;
  title?: string; // Defaults to `name`
  description?: string;
  arguments?: MCPPromptArgumentConfig[];
  get: (
    args: Record<string, string>,
    caller?: MCPCaller // Who `auth` established, on the HTTP transport
  ) => Promise<MCPPromptResult> | MCPPromptResult;
}

interface MCPPromptArgumentConfig {
  name: string;
  description?: string;
  required?: boolean;
}

interface MCPPromptResult {
  messages: MCPPromptReplyMessage[];
  description?: string;
}

// A message `get` returns: string content is sent as a text block
interface MCPPromptReplyMessage {
  role: 'user' | 'assistant';
  content: string | MCPPromptMessage['content'];
}
```

String content keeps simple prompts short:

```typescript
server.registerPrompt({
  name: 'translate',
  arguments: [{ name: 'text', required: true }],
  get: ({ text }) => ({
    messages: [{ role: 'user', content: `Translate into French:\n\n${text}` }],
  }),
});
```

### HTTP Server

Run MCP over HTTP:

```typescript
const server = new MCPServer({
  name: 'http-tools',
  version: '1.0.0',
  transport: 'http',
  port: 3001,
  host: '0.0.0.0',
  logging: true,
});

server.registerTools(myTools);
await server.start();
// Server listening on http://0.0.0.0:3001/mcp
```

The MCP endpoint is `/mcp` (other paths answer 404); it takes `POST`, `GET` and `DELETE`, answers CORS preflights, and rejects bodies over `maxBodySize` with 413 and invalid JSON with a JSON-RPC parse error. `transport: 'sse'` serves the same Streamable HTTP endpoint.

The server speaks 2026-07-28 to clients that do and 2025-11-25 to older ones (`legacyClients: false` refuses those). Clients of 2026-07-28 have no sessions: every request stands on its own, and the server asks them through multi round-trip requests (see [Approvals and Questions](#approvals-and-questions-across-rounds)). For 2025-11-25 clients every request is served on its own by default. With `sessions: true` the server keeps a session per such client, keyed by the `mcp-session-id` header: a request without one starts a session, an unknown session id gets 404, and a session can only be used by the caller (`userId`) that started it (403 otherwise). Sessions are what let the server send requests back to a 2025-11-25 client, such as elicitation.

CORS preflights may send the MCP headers (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` and the `Mcp-Param-*` headers of tool arguments). `allowedOrigins` refuses requests from other browser origins with 403 (by default any origin when `corsOrigin` is `*`).

### Approvals and Questions Across Rounds

On 2026-07-28 a call that needs the person at the client ends its round: a tool call that needs approval answers with an approval form and a signed `requestState`, and runs once the client calls again with the decision. The state is signed with HMAC under `requestStateKey`, bound to the caller and to the tool and its arguments, and valid for `elicitationTimeoutMs`: a state that was changed, expired, or brought by another caller or for other arguments asks again. Give every process that serves the same clients the same `requestStateKey` (at least 32 bytes), by default each process makes its own.

`context.elicit()` keeps working as before: the call waits in the server process while the client answers, so every round of such a call has to reach the same process. `context.input` asks without waiting: `input.ask(requests, state)` ends the round, and the tool runs again with `input.responses` and the `state` it kept, on any process with the key.

```typescript
const pickColor = tool({
  name: 'pick_color',
  description: 'Paint in a color the user picks',
  parameters: z.object({}),
  execute: async (_params, context: MCPToolContext) => {
    const input = context.input!;
    const reply = input.responses.color;
    if (reply?.action !== 'accept') {
      return input.ask(
        {
          color: {
            message: 'Which color?',
            schema: { type: 'object', properties: { c: { type: 'string' } } },
          },
        },
        { step: 'color' }
      );
    }
    return `painted ${String(reply.content.c)}`;
  },
});
```

### Tasks

A call still running after `tasks.promoteAfterMs` (default 2 s) becomes an MCP task for clients that take tasks: the client gets the task, polls it with `tasks/get`, answers its questions with `tasks/update` and stops it with `tasks/cancel`. Approvals and `context.elicit()` of a task are asked in its `input_required` status. A task belongs to the caller that started it, others get `Unknown task`. Tasks live in `tasks.store` (an `InMemoryMCPTaskStore` by default) for `tasks.ttlMs` (an hour), `tasks: false` turns them off.

### OAuth Protected Resource Metadata

With `protectedResource: { authorizationServers: ['https://auth.example.com'] }` the server serves its OAuth Protected Resource Metadata (RFC 9728) at `/.well-known/oauth-protected-resource/mcp` and names it in the `WWW-Authenticate` header of a 401, so OAuth clients find the authorization server. `auth` still checks the token.

### Authentication and Per-User Tools

Over HTTP the server is open to anyone who can reach it. `auth` establishes the caller of every request; requests it returns `undefined` for (or throws on) get `401`. The caller's `userId` reaches tools as `context.userId`, and resource `read` / prompt `get` handlers get the caller as their second argument:

```typescript
import { MCPServer } from '@cogitator-ai/mcp';
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const server = new MCPServer({
  name: 'shop',
  version: '1.0.0',
  transport: 'http',
  auth: (request) => {
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    const userId = token ? tokens.get(token) : undefined;
    return userId ? { userId } : undefined;
  },
});

server.registerTool(
  tool({
    name: 'list_my_orders',
    description: "List the calling customer's orders",
    parameters: z.object({}),
    execute: async (_args, context) => orders.forUser(context.userId!),
  })
);
```

An agent acts for one user by connecting with that user's token (`headers: { Authorization: \`Bearer ${token}\` }`) and running with their `userId` — see [`examples/mcp/03-per-user-mcp.ts`](https://github.com/cogitator-ai/Cogitator-AI/blob/main/examples/mcp/03-per-user-mcp.ts).

### Asking the User (Elicitation)

A tool run by an `MCPServer` gets an `MCPToolContext`: the usual tool context plus `elicit`, which asks the person at the client a question (an MCP elicitation form) while the call waits. For 2026-07-28 clients the question goes out with the round's answer and the call waits for the next round, for 2025-11-25 clients as a request, on stdio and on HTTP with `sessions: true`. It resolves to `undefined` when the client cannot answer elicitation requests.

```typescript
import { tool } from '@cogitator-ai/core';
import type { MCPToolContext } from '@cogitator-ai/mcp';
import { z } from 'zod';

const deleteBranch = tool({
  name: 'delete_branch',
  description: 'Delete a git branch',
  parameters: z.object({ branch: z.string() }),
  execute: async ({ branch }, context: MCPToolContext) => {
    const reply = await context.elicit?.({
      message: `Delete ${branch}?`,
      schema: {
        type: 'object',
        properties: { confirm: { type: 'boolean', title: 'Delete', default: false } },
        required: ['confirm'],
      },
    });
    if (reply?.action !== 'accept' || reply.content.confirm !== true) return 'Cancelled';
    return `Deleted ${branch}`;
  },
});
```

Form fields (`MCPElicitField`) are the primitives of the MCP elicitation schema (protocol 2025-11-25): strings (with `minLength`, `maxLength`, `format` of `email`, `uri`, `date` or `date-time`, a single choice as `enum` or as `oneOf` with labels), numbers and integers (with `minimum` and `maximum`), booleans, and multiple choices (`type: 'array'` with string `items`), each with an optional `title`, `description` and `default`. The reply is `{ action: 'accept', content }` or `{ action: 'decline' | 'cancel' }`.

An elicitation waits for the user up to `elicitationTimeoutMs` (default 10 minutes, instead of the MCP SDK's 60 s request timeout, which is too short for a person, `0` waits as long as the tool call lasts), and stops when the tool call is cancelled. One nobody answers in time counts as dismissed (`cancel`): a tool call waiting for approval is then declined.

### Stdio Server (for Claude Desktop)

Create a script that Claude Desktop can execute:

```typescript
// serve-tools.ts
import { serveMCPTools } from '@cogitator-ai/mcp';
import { Cogitator, calculator, datetime, webSearch } from '@cogitator-ai/core';

await serveMCPTools([calculator, datetime, webSearch], {
  name: 'cogitator-tools',
  version: '1.0.0',
  transport: 'stdio',
  toolInvoker: new Cogitator({ sandbox: { allowNativeFallback: false } }),
});
```

Add to Claude Desktop config:

```json
{
  "mcpServers": {
    "cogitator": {
      "command": "npx",
      "args": ["tsx", "/path/to/serve-tools.ts"]
    }
  }
}
```

---

## Serving Agents

Serve Cogitator agents to Claude Desktop, Cursor or any MCP client in one call; each agent becomes a tool that takes a `task` (and a `threadId` to continue a conversation, with memory on):

```typescript
import { Agent, Cogitator } from '@cogitator-ai/core';
import { serveAgents, type MCPAuthFunction } from '@cogitator-ai/mcp';

const cog = new Cogitator({ memory: { adapter: 'memory' } });
const researcher = new Agent({
  name: 'researcher',
  description: 'Researches a topic and answers with sources.',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You research topics thoroughly.',
});

await serveAgents(cog, [researcher]); // stdio, for Claude Desktop

// or remote, per user:
const auth: MCPAuthFunction = (request) =>
  request.headers.authorization === `Bearer ${process.env.MCP_TOKEN}`
    ? { userId: 'owner' }
    : undefined;
await serveAgents(cog, researcher, { transport: 'http', port: 3333, auth });
```

`serveAgents(host, agents, config?)` takes anything with Cogitator's `run` and `resume` (`AgentHost`), one agent or a list, and the `MCPServerConfig` options, all optional: it defaults to `name: 'cogitator-agents'`, `version: '1.0.0'`, `transport: 'stdio'` and `sessions: true`. It starts the server and returns the `MCPServer`.

- **Tool names** — the agent's name with characters outside `[a-zA-Z0-9_-]` replaced by `_`; pass `toolNames: { researcher: 'research' }` to choose your own.
- **Descriptions** — the agent's `description`, or `Ask the <name> agent.` plus the first sentence of its instructions.
- **Answers** (`AgentToolAnswer`) — `{ status: 'completed', output, threadId }`; pass the `threadId` back to continue the conversation.
- **Approvals**: when a call of the agent needs approval (its tool's `requiresApproval`, or a permission rule), it is asked from the person at the client through MCP elicitation (an Approve checkbox and an optional reason). A client that cannot answer gets `{ status: 'paused', threadId, pendingApprovals, next }`, and the agent gets a second tool, `<name>_resume` (registered for every agent, since permission rules can make any call ask), taking `{ threadId, approved, reason? }` to continue the run with the user's decision. `allowRemember: true` lets the client answer "always allow" (`remember`), off by default. Tools from `wrapMCPTools()` carry `tool.mcp = { server, tool }` (the `server` option, else the name the server reports) for `mcp__<server>__<tool>` permission rules.
- **Questions** - a question an agent's tool asks with `context.interrupt()` is asked from the person at the client through MCP elicitation too, one form per question: a schema of one primitive (or none) becomes a single `answer` field, an object of primitives becomes that form, with the constraints the elicitation schema can carry (title, description, default, length, format, range, choices). The run resumes with the answers, as often as its tools ask, and checks them against the full schema. An answer it refuses (`INTERRUPT_ANSWER_INVALID`, say for a `pattern` the form cannot carry) is asked again, the form saying why, up to 3 times per question: then the call fails with an `isError` result naming the question. When nobody can answer (a client without elicitation, a declined or dismissed form, one nobody answers within `elicitationTimeoutMs`, or a schema that is no flat form) the call fails with an `isError` result naming the question, such as `paused to ask confirm_plan ("Go ahead?")`. Either way the run stays paused for `cogitator.resume()` with `responses`.
- **Callers** — over HTTP with `auth`, the caller's `userId` is passed to the run, and the run's abort signal follows the MCP call's cancellation.
- **Protocol 2026-07-28** - for clients of the new revision a run that needs an approval or an answer pauses, the round ends with every approval and question it waits on and a signed state that names its thread, and the client's next round resumes it (`cogitator.resume()` with `decisions` and `responses`). Nothing waits in the server between rounds, so with persistent memory and a shared `requestStateKey` any server process can take the next round. A run still going after `tasks.promoteAfterMs` becomes an MCP task the client polls.

`agentTools(host, agents, toolNames?)` returns the same tools without starting a server, to register them on an `MCPServer` of your own next to other tools. See [`examples/mcp/04-agent-as-mcp-server.ts`](https://github.com/cogitator-ai/Cogitator-AI/blob/main/examples/mcp/04-agent-as-mcp-server.ts).

## Tool Adapters

Convert between Cogitator and MCP tool formats.

### Cogitator → MCP

```typescript
import { cogitatorToMCP } from '@cogitator-ai/mcp';
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const myTool = tool({
  name: 'greet',
  description: 'Greet someone',
  parameters: z.object({
    name: z.string(),
  }),
  execute: async ({ name }) => `Hello, ${name}!`,
});

const mcpDefinition = cogitatorToMCP(myTool);
// {
//   name: 'greet',
//   description: 'Greet someone',
//   inputSchema: {
//     type: 'object',
//     properties: { name: { type: 'string' } },
//     required: ['name']
//   }
// }
```

The definition carries the tool's `title`, `annotations` and a `z.object()` `outputSchema` as JSON Schema when the tool has them.

`toolSchemaToMCP(schema)` does the same for a plain `ToolSchema` (the output of `tool.toJSON()`).

### MCP → Cogitator

```typescript
import { mcpToCogitator, wrapMCPTools } from '@cogitator-ai/mcp';

// Single tool
const [definition] = await client.listToolDefinitions();
const cogitatorTool = mcpToCogitator(definition, client, {
  namePrefix: 'mcp_',
  descriptionTransform: (desc) => `[MCP] ${desc}`,
});

// All tools from a client
const tools = await wrapMCPTools(client, {
  namePrefix: 'fs_',
});
```

The prefix only renames the Cogitator tool; calls still go to the server under the original name, with the run's abort signal.

Tool names are made safe for every LLM provider (letters, digits, `_` and `-`, at most 64 characters): `admin.list_users` becomes `admin_list_users`, a longer name is cut and ends with a hash of the full one, and two names of a server that would end up the same (`files.read`, `files_read`) are told apart by a hash on the changed one. `normalizeMCPToolName(name)` gives the name a tool gets, the same as `normalizeToolName` of `@cogitator-ai/core`. When an agent uses several servers, give each its own `namePrefix`, since two servers can both have a `search` tool: the registry warns when two tools of an agent share a name, and only one of them would reach the model.

Input schemas with `$ref` (such as a FastMCP tool with a nested Pydantic model) keep their definitions: the model sees the full schema and arguments are validated against it, recursive definitions included.

Imported tools keep the server's `title` (or the title of its annotations), its hints as `annotations` and its `outputSchema` as a zod schema of the result. A tool the server marks destructive (`destructiveHint: true` without `readOnlyHint: true`) needs approval: a Cogitator run pauses before it runs, as for any `requiresApproval` tool. A tool without the hint is not taken as destructive, although MCP's own default for a missing hint is `true`, since that would ask approval for every tool of most servers. Hints are only as trustworthy as the server: they can add approval, never take it away from a tool you mark yourself.

```typescript
// Ask for every call of an untrusted server, or for none of a trusted one
const strict = await client.getTools({ requiresApproval: true });
const relaxed = await client.getTools({ requiresApproval: false });

// Or decide per tool
const tools = await client.getTools({
  requiresApproval: (tool) => isDestructiveMCPTool(tool) || tool.name.startsWith('delete_'),
});
```

### Adapter Options

```typescript
interface ToolAdapterOptions {
  namePrefix?: string;
  descriptionTransform?: (description: string) => string;
  /** Default: the tools the server marks destructive (isDestructiveMCPTool) */
  requiresApproval?: boolean | ((tool: MCPToolDefinition) => boolean);
}
```

---

## Schema Converters

Convert between Zod schemas and JSON Schema.

### Zod → JSON Schema

```typescript
import { zodToJsonSchema } from '@cogitator-ai/mcp';
import { z } from 'zod';

const schema = z.object({
  name: z.string().min(1).describe('User name'),
  age: z.number().int().min(0).optional(),
  email: z.string().email(),
  role: z.enum(['admin', 'user', 'guest']),
});

const jsonSchema = zodToJsonSchema(schema);
// {
//   type: 'object',
//   properties: {
//     name: { type: 'string', minLength: 1, description: 'User name' },
//     age: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
//     email: { type: 'string', format: 'email', pattern: '...' },
//     role: { type: 'string', enum: ['admin', 'user', 'guest'] }
//   },
//   required: ['name', 'email', 'role'],
//   additionalProperties: false
// }
```

The output targets OpenAPI 3.0 (e.g. `nullable: true` instead of `type: [..., 'null']`), describes the parsed output of the schema, and turns types JSON Schema cannot express into `{}`.

### JSON Schema → Zod

```typescript
import { jsonSchemaToZod } from '@cogitator-ai/mcp';

const jsonSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query' },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['query'],
};

const zodSchema = jsonSchemaToZod(jsonSchema);

const result = zodSchema.parse({
  query: 'test',
  limit: 10,
  tags: ['a', 'b'],
});
```

### Supported Conversions

| JSON Schema                      | Zod                              |
| -------------------------------- | -------------------------------- |
| `string`                         | `z.string()`                     |
| `string` + `minLength/maxLength` | `z.string().min().max()`         |
| `string` + `pattern`             | `z.string().regex()`             |
| `string` + `format: email`       | `z.string().email()`             |
| `string` + `format: uri` / `url` | `z.string().url()`               |
| `number`                         | `z.number()`                     |
| `integer`                        | `z.number().int()`               |
| `number` + `minimum/maximum`     | `z.number().min().max()`         |
| `boolean`                        | `z.boolean()`                    |
| `array`                          | `z.array()`                      |
| `object`                         | `z.object()`                     |
| top-level `object` w/o props     | `z.looseObject({})`              |
| nested `object` w/o props        | `z.record(z.string(), ...)`      |
| `additionalProperties: true`     | `z.looseObject()`                |
| `additionalProperties: {schema}` | `.catchall()` / `z.record()`     |
| `null`                           | `z.null()`                       |
| `enum`                           | `z.enum()` / literal union       |
| `const`                          | `z.literal()`                    |
| `type: ['string', 'null']`       | `z.union()`                      |
| `nullable: true` (OpenAPI)       | `.nullable()`                    |
| `oneOf` / `anyOf` / `allOf`      | `z.union()` / `z.intersection()` |
| `default`                        | `.default()`                     |
| not in `required`                | `.optional()`                    |

Unknown types become `z.unknown()`. Patterns that are not valid ECMAScript regular expressions are ignored instead of failing the whole conversion.

---

## Resources

Access data from MCP servers that expose resources.

```typescript
const client = await MCPClient.connect(config);

const resources = await client.listResources();
// [
//   { uri: 'file:///path/to/file.txt', name: 'file.txt', mimeType: 'text/plain' },
//   { uri: 'config://settings', name: 'Settings', description: 'App settings' },
// ]

const content = await client.readResource('file:///path/to/file.txt');
// {
//   uri: 'file:///path/to/file.txt',
//   mimeType: 'text/plain',
//   text: 'File contents here...',
// }

if (content.blob) {
  const data = Buffer.from(content.blob, 'base64');
}
```

### Resource Types

```typescript
interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

interface MCPResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string; // Base64 encoded
}
```

---

## Prompts

Access prompt templates from MCP servers.

```typescript
const client = await MCPClient.connect(config);

const prompts = await client.listPrompts();
// [
//   {
//     name: 'code_review',
//     description: 'Review code for issues',
//     arguments: [
//       { name: 'code', required: true },
//       { name: 'language', required: false }
//     ]
//   }
// ]

const messages = await client.getPrompt('code_review', {
  code: 'function add(a, b) { return a + b; }',
  language: 'javascript',
});
// [
//   {
//     role: 'user',
//     content: { type: 'text', text: 'Please review this JavaScript code...' }
//   }
// ]
```

### Prompt Types

```typescript
interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: MCPPromptArgument[];
}

interface MCPPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

interface MCPPromptMessage {
  role: 'user' | 'assistant';
  content: {
    type: 'text' | 'image' | 'audio' | 'resource' | 'resource_link';
    text?: string; // text
    data?: string; // image / audio, base64
    mimeType?: string;
    resource?: { uri: string; mimeType?: string; text?: string; blob?: string }; // resource / resource_link
  };
}
```

---

## Examples

### Multi-Server Integration

Use tools from multiple MCP servers:

```typescript
import { MCPClient, wrapMCPTools } from '@cogitator-ai/mcp';
import { Agent, Cogitator } from '@cogitator-ai/core';

const fsClient = await MCPClient.connect({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
});

const gitClient = await MCPClient.connect({
  transport: 'stdio',
  command: 'uvx',
  args: ['mcp-server-git', '--repository', '/workspace'],
});

const fsTools = await wrapMCPTools(fsClient, { namePrefix: 'fs_' });
const gitTools = await wrapMCPTools(gitClient, { namePrefix: 'git_' });

const agent = new Agent({
  name: 'Dev Assistant',
  model: 'ollama/llama3.1:8b',
  instructions: 'You can manage files and git repositories.',
  tools: [...fsTools, ...gitTools],
});

const cog = new Cogitator();
const result = await cog.run(agent, {
  input: 'Create a new file called hello.ts and commit it',
});

await fsClient.close();
await gitClient.close();
await cog.close();
```

### Capability-Based Tool Selection

Check server capabilities before using features:

```typescript
import type { Tool } from '@cogitator-ai/types';

const client = await MCPClient.connect(config);
const capabilities = client.getCapabilities();

const tools: Tool[] = [];

if (capabilities.tools) {
  tools.push(...(await client.getTools()));
}

if (capabilities.resources) {
  const resources = await client.listResources();
  console.log(`Available resources: ${resources.length}`);
}

if (capabilities.prompts) {
  const prompts = await client.listPrompts();
  console.log(`Available prompts: ${prompts.length}`);
}
```

### Error Handling

```typescript
import { MCPClient } from '@cogitator-ai/mcp';

try {
  const client = await MCPClient.connect({
    transport: 'stdio',
    command: 'nonexistent-command',
    timeout: 5000,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'Connection timeout') {
    console.error('Connection timed out');
  } else if (message.includes('ENOENT')) {
    console.error('Command not found');
  } else {
    console.error('Connection failed:', message);
  }
}
```

### Content Conversion

Handle different content types from tool results:

```typescript
import { resultToMCPContent, mcpContentToResult } from '@cogitator-ai/mcp';

const result = { data: [1, 2, 3], status: 'ok' };
const mcpContent = resultToMCPContent(result);
// [{ type: 'text', text: '{\n  "data": [\n    1, ...' }] (pretty-printed JSON)

const parsed = mcpContentToResult(mcpContent);
// { data: [1, 2, 3], status: 'ok' }

const textResult = resultToMCPContent('Hello world');
// [{ type: 'text', text: 'Hello world' }]
```

A tool result that is already an array of MCP content blocks (text, image, audio, resource) is passed through unchanged, so a served tool can return images or embedded resources, `null`/`undefined` becomes an empty text block. A `toolContent()` result, and an object with a base64 `image` such as a browser screenshot, becomes text and image blocks, with `file` parts as audio blocks (`audio/*`) or embedded resource blobs, `json` parts as JSON text, and `resource` parts as embedded resources (text or blob) or, for a resource with no contents, a line of text naming it.

---

## Type Reference

```typescript
import type {
  // Transport
  MCPTransportType,
  StdioTransportConfig,
  HttpTransportConfig,

  // Client
  MCPClientConfig,
  MCPRetryConfig,
  MCPCallToolOptions,

  // Server
  MCPServerConfig,
  MCPAuthFunction,
  MCPCaller,
  MCPToolContext,
  MCPElicitRequest,
  MCPElicitResult,
  MCPElicitField,
  MCPResourceConfig,
  MCPResourceReadContent,
  MCPPromptConfig,
  MCPPromptArgumentConfig,
  MCPPromptResult,
  MCPPromptReplyMessage,

  // Serving agents
  AgentHost,
  AgentToolAnswer,
  ServeAgentsConfig,

  // Tools
  MCPToolDefinition,
  MCPToolCallResult,
  MCPToolContent,

  // Resources
  MCPResource,
  MCPResourceContent,

  // Prompts
  MCPPrompt,
  MCPPromptArgument,
  MCPPromptMessage,

  // Adapters
  ToolAdapterOptions,
} from '@cogitator-ai/mcp';
```

---

## License

MIT
