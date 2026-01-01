'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';

interface Recipe {
  id: string;
  title: string;
  difficulty: 'easy' | 'medium' | 'advanced';
  time: string;
}

interface Section {
  id: string;
  title: string;
  icon: string;
  recipes: Recipe[];
}

const sections: Section[] = [
  {
    id: 'getting-started',
    title: 'Getting Started',
    icon: '🚀',
    recipes: [
      { id: 'first-agent', title: 'Your First Agent', difficulty: 'easy', time: '5 min' },
      { id: 'custom-tools', title: 'Adding Custom Tools', difficulty: 'easy', time: '10 min' },
      { id: 'streaming', title: 'Streaming Responses', difficulty: 'easy', time: '5 min' },
    ],
  },
  {
    id: 'agents',
    title: 'Agents',
    icon: '🤖',
    recipes: [
      { id: 'research-agent', title: 'Research Agent', difficulty: 'medium', time: '15 min' },
      { id: 'code-assistant', title: 'Code Assistant', difficulty: 'medium', time: '20 min' },
      { id: 'slack-bot', title: 'Slack Bot Agent', difficulty: 'medium', time: '15 min' },
      { id: 'data-analyst', title: 'Data Analyst', difficulty: 'medium', time: '20 min' },
      { id: 'support-agent', title: 'Customer Support', difficulty: 'medium', time: '15 min' },
    ],
  },
  {
    id: 'workflows',
    title: 'Workflows',
    icon: '🔄',
    recipes: [
      { id: 'simple-pipeline', title: 'Simple Pipeline', difficulty: 'easy', time: '10 min' },
      { id: 'human-in-loop', title: 'Human-in-the-Loop', difficulty: 'medium', time: '15 min' },
      {
        id: 'parallel-processing',
        title: 'Parallel Processing',
        difficulty: 'medium',
        time: '15 min',
      },
      { id: 'retry-recovery', title: 'Retry & Recovery', difficulty: 'advanced', time: '20 min' },
      {
        id: 'scheduled-workflows',
        title: 'Scheduled Workflows',
        difficulty: 'medium',
        time: '15 min',
      },
    ],
  },
  {
    id: 'swarms',
    title: 'Swarms',
    icon: '🐝',
    recipes: [
      { id: 'hierarchical-team', title: 'Hierarchical Team', difficulty: 'medium', time: '20 min' },
      { id: 'debate-swarm', title: 'Debate Decision', difficulty: 'medium', time: '15 min' },
      { id: 'consensus-voting', title: 'Consensus Voting', difficulty: 'medium', time: '15 min' },
      { id: 'pipeline-assembly', title: 'Pipeline Assembly', difficulty: 'easy', time: '10 min' },
      { id: 'auction-tasks', title: 'Auction Tasks', difficulty: 'advanced', time: '20 min' },
      { id: 'round-robin', title: 'Round-Robin', difficulty: 'easy', time: '10 min' },
    ],
  },
  {
    id: 'reasoning',
    title: 'Advanced Reasoning',
    icon: '🧠',
    recipes: [
      { id: 'tree-of-thoughts', title: 'Tree of Thoughts', difficulty: 'advanced', time: '20 min' },
      { id: 'self-reflection', title: 'Self-Reflection', difficulty: 'medium', time: '15 min' },
      { id: 'agent-learning', title: 'Agent Learning', difficulty: 'advanced', time: '25 min' },
      { id: 'time-travel', title: 'Time-Travel Debug', difficulty: 'advanced', time: '20 min' },
      {
        id: 'guardrails',
        title: 'Constitutional Guardrails',
        difficulty: 'medium',
        time: '15 min',
      },
    ],
  },
  {
    id: 'self-modifying',
    title: 'Self-Modifying',
    icon: '🧬',
    recipes: [
      {
        id: 'auto-generate-tools',
        title: 'Auto-Generate Tools',
        difficulty: 'advanced',
        time: '20 min',
      },
      {
        id: 'meta-reasoning',
        title: 'Meta-Reasoning Modes',
        difficulty: 'advanced',
        time: '15 min',
      },
      {
        id: 'architecture-evolution',
        title: 'Architecture Evolution',
        difficulty: 'advanced',
        time: '20 min',
      },
    ],
  },
  {
    id: 'causal',
    title: 'Causal Reasoning',
    icon: '🔬',
    recipes: [
      { id: 'root-cause', title: 'Root Cause Analysis', difficulty: 'advanced', time: '20 min' },
      {
        id: 'effect-prediction',
        title: 'Effect Prediction',
        difficulty: 'advanced',
        time: '15 min',
      },
      {
        id: 'counterfactual',
        title: 'Counterfactual Reasoning',
        difficulty: 'advanced',
        time: '20 min',
      },
    ],
  },
  {
    id: 'neuro-symbolic',
    title: 'Neuro-Symbolic',
    icon: '🔢',
    recipes: [
      {
        id: 'logic-programming',
        title: 'Logic Programming',
        difficulty: 'advanced',
        time: '20 min',
      },
      {
        id: 'constraint-solving',
        title: 'Constraint Solving',
        difficulty: 'advanced',
        time: '20 min',
      },
      {
        id: 'plan-verification',
        title: 'Plan Verification',
        difficulty: 'advanced',
        time: '15 min',
      },
    ],
  },
  {
    id: 'memory',
    title: 'Memory & RAG',
    icon: '💾',
    recipes: [
      {
        id: 'conversation-memory',
        title: 'Conversation Memory',
        difficulty: 'easy',
        time: '10 min',
      },
      { id: 'semantic-search', title: 'Semantic Search', difficulty: 'medium', time: '15 min' },
      { id: 'long-term-memory', title: 'Long-term Memory', difficulty: 'medium', time: '15 min' },
    ],
  },
  {
    id: 'sandbox',
    title: 'Sandbox',
    icon: '📦',
    recipes: [
      { id: 'docker-execution', title: 'Docker Execution', difficulty: 'medium', time: '15 min' },
      { id: 'wasm-execution', title: 'WASM Execution', difficulty: 'medium', time: '10 min' },
    ],
  },
  {
    id: 'mcp',
    title: 'MCP Integration',
    icon: '🔌',
    recipes: [
      { id: 'connect-mcp', title: 'Connect MCP Servers', difficulty: 'medium', time: '15 min' },
      { id: 'create-mcp', title: 'Create MCP Server', difficulty: 'advanced', time: '20 min' },
    ],
  },
  {
    id: 'production',
    title: 'Production',
    icon: '💰',
    recipes: [
      { id: 'cost-routing', title: 'Cost-Aware Routing', difficulty: 'medium', time: '15 min' },
      { id: 'budget-enforcement', title: 'Budget Enforcement', difficulty: 'easy', time: '10 min' },
      { id: 'otel-tracing', title: 'OpenTelemetry Tracing', difficulty: 'medium', time: '15 min' },
      { id: 'error-handling', title: 'Error Handling', difficulty: 'medium', time: '15 min' },
    ],
  },
];

function CodeBlock({ children, language = 'typescript' }: { children: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group my-4">
      <div className="absolute top-2 right-2 z-10">
        <button
          onClick={copy}
          className="px-2 py-1 text-xs bg-[#1a1a1a] text-[#666] rounded border border-[#333] hover:border-[#00ff88] hover:text-[#00ff88] transition-all"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <div className="absolute top-2 left-3 text-xs text-[#666] font-mono">{language}</div>
      <pre className="bg-[#0f0f0f] border border-[#1a1a1a] rounded-lg p-4 pt-8 overflow-x-auto">
        <code className="text-sm font-mono text-[#e1e1e1]">{children}</code>
      </pre>
    </div>
  );
}

function Callout({
  type,
  children,
}: {
  type: 'info' | 'warning' | 'tip';
  children: React.ReactNode;
}) {
  const styles = {
    info: 'border-[#00aaff] bg-[#00aaff]/5 text-[#00aaff]',
    warning: 'border-[#ffaa00] bg-[#ffaa00]/5 text-[#ffaa00]',
    tip: 'border-[#00ff88] bg-[#00ff88]/5 text-[#00ff88]',
  };
  const icons = { info: 'ℹ️', warning: '⚠️', tip: '💡' };

  return (
    <div className={`my-4 p-4 border-l-4 rounded-r-lg ${styles[type]}`}>
      <span className="mr-2">{icons[type]}</span>
      <span className="text-[#e1e1e1]">{children}</span>
    </div>
  );
}

function DifficultyBadge({ level }: { level: 'easy' | 'medium' | 'advanced' }) {
  const colors = {
    easy: 'bg-[#00ff88]/10 text-[#00ff88] border-[#00ff88]/30',
    medium: 'bg-[#ffaa00]/10 text-[#ffaa00] border-[#ffaa00]/30',
    advanced: 'bg-[#ff5555]/10 text-[#ff5555] border-[#ff5555]/30',
  };
  return <span className={`px-2 py-0.5 text-xs rounded border ${colors[level]}`}>{level}</span>;
}

function RecipeContent({ recipeId }: { recipeId: string }) {
  const content: Record<string, React.ReactNode> = {
    'getting-started': (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">Getting Started</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Learn the basics of building AI agents with Cogitator. These recipes will get you up and
          running in minutes.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            { icon: '⚡', title: '5 Minutes', desc: 'From zero to first agent' },
            { icon: '🔧', title: 'Type-Safe', desc: 'Full TypeScript support' },
            { icon: '🏠', title: 'Local First', desc: 'Works with Ollama' },
          ].map((item) => (
            <div key={item.title} className="p-4 bg-[#111] border border-[#222] rounded-lg">
              <div className="text-2xl mb-2">{item.icon}</div>
              <h3 className="text-[#fafafa] font-semibold">{item.title}</h3>
              <p className="text-[#666] text-sm">{item.desc}</p>
            </div>
          ))}
        </div>
      </>
    ),

    'first-agent': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Your First Agent</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="easy" />
          <span className="text-[#666] text-sm">5 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Create a Cogitator instance</li>
          <li>Define an Agent with instructions</li>
          <li>Run the agent and get results</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">Prerequisites</h3>
        <CodeBlock language="bash">{`# Install Cogitator
pnpm add @cogitator-ai/core

# Start Ollama (for local models)
ollama serve
ollama pull llama3.2`}</CodeBlock>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Cogitator, Agent } from '@cogitator-ai/core';

// 1. Create Cogitator instance
const cog = new Cogitator({
  defaultBackend: 'ollama',
  ollama: { baseUrl: 'http://localhost:11434' },
});

// 2. Define your agent
const assistant = new Agent({
  name: 'assistant',
  model: 'ollama/llama3.2',
  instructions: \`You are a helpful assistant.
    Be concise and friendly in your responses.\`,
});

// 3. Run the agent
const result = await cog.run(assistant, {
  input: 'What is the capital of France?',
});

console.log(result.output);
// "The capital of France is Paris."

console.log(result.usage);
// { inputTokens: 45, outputTokens: 12, totalTokens: 57 }`}</CodeBlock>

        <Callout type="tip">
          Replace <code>ollama/llama3.2</code> with <code>openai/gpt-4o</code> or{' '}
          <code>anthropic/claude-3-5-sonnet</code> to use cloud models.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">How It Works</h3>
        <ol className="list-decimal list-inside text-[#a1a1a1] space-y-2">
          <li>
            <strong className="text-[#fafafa]">Cogitator</strong> is the runtime that manages LLM
            connections, memory, and execution
          </li>
          <li>
            <strong className="text-[#fafafa]">Agent</strong> defines personality, model, and
            capabilities
          </li>
          <li>
            <strong className="text-[#fafafa]">cog.run()</strong> executes the agent and returns
            structured output
          </li>
        </ol>
      </>
    ),

    'custom-tools': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Adding Custom Tools</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="easy" />
          <span className="text-[#666] text-sm">10 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Define tools with Zod schemas</li>
          <li>Register tools with an agent</li>
          <li>Handle tool execution results</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

// Define a custom tool with Zod schema
const weatherTool = tool({
  name: 'get_weather',
  description: 'Get current weather for a city',
  parameters: z.object({
    city: z.string().describe('City name'),
    units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
  }),
  execute: async ({ city, units }) => {
    // Your API call here
    const response = await fetch(
      \`https://api.weather.com/v1/current?city=\${city}\`
    );
    const data = await response.json();
    return {
      temperature: units === 'celsius' ? data.temp_c : data.temp_f,
      conditions: data.conditions,
      humidity: data.humidity,
    };
  },
});

// Create agent with tools
const weatherBot = new Agent({
  name: 'weather-bot',
  model: 'ollama/llama3.2',
  instructions: 'You help users check the weather. Use the get_weather tool.',
  tools: [weatherTool],
});

// Run - agent will automatically use the tool
const result = await cog.run(weatherBot, {
  input: 'What\\'s the weather like in Tokyo?',
});

console.log(result.output);
// "The current weather in Tokyo is 22°C with partly cloudy conditions..."

console.log(result.toolCalls);
// [{ name: 'get_weather', args: { city: 'Tokyo', units: 'celsius' }, result: {...} }]`}</CodeBlock>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Multiple Tools</h3>
        <CodeBlock>{`const searchTool = tool({
  name: 'web_search',
  description: 'Search the web for information',
  parameters: z.object({
    query: z.string(),
    maxResults: z.number().default(5),
  }),
  execute: async ({ query, maxResults }) => {
    // Search implementation
    return { results: [...] };
  },
});

const calculatorTool = tool({
  name: 'calculate',
  description: 'Perform mathematical calculations',
  parameters: z.object({
    expression: z.string().describe('Math expression like "2 + 2"'),
  }),
  execute: async ({ expression }) => {
    return { result: eval(expression) }; // Use mathjs in production!
  },
});

const agent = new Agent({
  name: 'multi-tool-agent',
  model: 'ollama/llama3.2',
  tools: [searchTool, calculatorTool, weatherTool],
});`}</CodeBlock>

        <Callout type="info">
          Tools are type-safe! TypeScript will catch errors if your execute function doesn&apos;t
          match the Zod schema.
        </Callout>
      </>
    ),

    streaming: (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Streaming Responses</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="easy" />
          <span className="text-[#666] text-sm">5 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Stream tokens as they&apos;re generated</li>
          <li>Display real-time output to users</li>
          <li>Handle streaming events</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Cogitator, Agent } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'storyteller',
  model: 'ollama/llama3.2',
  instructions: 'You write creative short stories.',
});

// Stream tokens as they arrive
const result = await cog.run(agent, {
  input: 'Write a haiku about programming',
  onToken: (token) => {
    // Print each token as it arrives
    process.stdout.write(token);
  },
});

// Output streams character by character:
// "Code flows like water..."

console.log('\\n---');
console.log('Total tokens:', result.usage.totalTokens);`}</CodeBlock>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">React Integration</h3>
        <CodeBlock language="tsx">{`'use client';
import { useState } from 'react';
import { Cogitator, Agent } from '@cogitator-ai/core';

export function ChatComponent() {
  const [response, setResponse] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  const handleSubmit = async (input: string) => {
    setResponse('');
    setIsStreaming(true);

    await cog.run(agent, {
      input,
      onToken: (token) => {
        setResponse(prev => prev + token);
      },
    });

    setIsStreaming(false);
  };

  return (
    <div>
      <div className="whitespace-pre-wrap">
        {response}
        {isStreaming && <span className="animate-pulse">▌</span>}
      </div>
    </div>
  );
}`}</CodeBlock>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Streaming Events</h3>
        <CodeBlock>{`const result = await cog.run(agent, {
  input: 'Complex task...',
  onToken: (token) => console.log('Token:', token),
  onToolCall: (tool, args) => console.log('Calling:', tool, args),
  onToolResult: (tool, result) => console.log('Result:', result),
  onThinking: (thought) => console.log('Thinking:', thought),
});`}</CodeBlock>

        <Callout type="tip">
          Streaming improves perceived latency - users see output immediately instead of waiting for
          the full response.
        </Callout>
      </>
    ),

    agents: (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">Agents</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Build specialized agents for different use cases. Each recipe shows a complete, working
          example.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[
            { icon: '🔍', title: 'Research', desc: 'Web search + summarization' },
            { icon: '💻', title: 'Code', desc: 'File I/O + execution' },
            { icon: '💬', title: 'Chat Bot', desc: 'Slack/Discord integration' },
            { icon: '📊', title: 'Data', desc: 'Analysis + visualization' },
            { icon: '🎧', title: 'Support', desc: 'Customer service + FAQs' },
          ].map((item) => (
            <div key={item.title} className="p-4 bg-[#111] border border-[#222] rounded-lg">
              <div className="text-2xl mb-2">{item.icon}</div>
              <h3 className="text-[#fafafa] font-semibold">{item.title}</h3>
              <p className="text-[#666] text-sm">{item.desc}</p>
            </div>
          ))}
        </div>
      </>
    ),

    'research-agent': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Research Agent</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">15 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Create a web search tool</li>
          <li>Parse and summarize web content</li>
          <li>Chain multiple tool calls</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const searchWeb = tool({
  name: 'search_web',
  description: 'Search the web for information',
  parameters: z.object({
    query: z.string().describe('Search query'),
    maxResults: z.number().default(5),
  }),
  execute: async ({ query, maxResults }) => {
    const response = await fetch(
      \`https://api.search.io/search?q=\${encodeURIComponent(query)}&limit=\${maxResults}\`
    );
    return response.json();
  },
});

const readUrl = tool({
  name: 'read_url',
  description: 'Read and extract text content from a URL',
  parameters: z.object({
    url: z.string().url(),
  }),
  execute: async ({ url }) => {
    const response = await fetch(url);
    const html = await response.text();
    // Use cheerio or similar to extract text
    return { content: extractText(html), url };
  },
});

const researcher = new Agent({
  name: 'researcher',
  model: 'openai/gpt-4o',
  instructions: \`You are a research assistant. When given a topic:
1. Search the web for relevant information
2. Read the most relevant URLs
3. Synthesize findings into a comprehensive summary
4. Always cite your sources\`,
  tools: [searchWeb, readUrl],
});

const cog = new Cogitator();
const result = await cog.run(researcher, {
  input: 'What are the latest developments in quantum computing?',
});

console.log(result.output);
// Comprehensive summary with citations...

console.log('Tool calls:', result.toolCalls.length);
// Tool calls: 6 (3 searches + 3 reads)`}</CodeBlock>

        <Callout type="tip">
          For production, use a real search API like Serper, Brave Search, or Tavily.
        </Callout>
      </>
    ),

    'code-assistant': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Code Assistant</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">20 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Read and write files safely</li>
          <li>Execute code in a sandbox</li>
          <li>Run tests and handle results</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { DockerSandbox } from '@cogitator-ai/sandbox';
import { z } from 'zod';
import * as fs from 'fs/promises';

const readFile = tool({
  name: 'read_file',
  description: 'Read a file from the filesystem',
  parameters: z.object({
    path: z.string().describe('File path to read'),
  }),
  execute: async ({ path }) => {
    const content = await fs.readFile(path, 'utf-8');
    return { content, path };
  },
});

const writeFile = tool({
  name: 'write_file',
  description: 'Write content to a file',
  parameters: z.object({
    path: z.string(),
    content: z.string(),
  }),
  execute: async ({ path, content }) => {
    await fs.writeFile(path, content, 'utf-8');
    return { success: true, path };
  },
});

const sandbox = new DockerSandbox({
  image: 'node:20-slim',
  timeout: 30000,
  memory: '512mb',
});

const runCode = tool({
  name: 'run_code',
  description: 'Execute JavaScript/TypeScript code in a sandbox',
  parameters: z.object({
    code: z.string(),
    language: z.enum(['javascript', 'typescript']).default('typescript'),
  }),
  execute: async ({ code, language }) => {
    const result = await sandbox.execute({ code, language });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  },
});

const codeAssistant = new Agent({
  name: 'code-assistant',
  model: 'anthropic/claude-3-5-sonnet',
  instructions: \`You are an expert coding assistant. You can:
- Read existing code files
- Write new code or modify existing files
- Run code to test your changes
- Debug issues by reading error output

Always test your code before declaring success.\`,
  tools: [readFile, writeFile, runCode],
});

const result = await cog.run(codeAssistant, {
  input: 'Create a function that calculates fibonacci numbers and test it',
});`}</CodeBlock>

        <Callout type="warning">
          Always use sandbox execution for untrusted code. Never run agent-generated code directly
          on your host.
        </Callout>
      </>
    ),

    'slack-bot': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Slack Bot Agent</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">15 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Integrate with Slack API</li>
          <li>Handle incoming messages</li>
          <li>Send responses back to channels</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { WebClient } from '@slack/web-api';
import { z } from 'zod';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

const sendMessage = tool({
  name: 'send_slack_message',
  description: 'Send a message to a Slack channel',
  parameters: z.object({
    channel: z.string().describe('Channel ID or name'),
    text: z.string().describe('Message text'),
    thread_ts: z.string().optional().describe('Thread timestamp for replies'),
  }),
  execute: async ({ channel, text, thread_ts }) => {
    const result = await slack.chat.postMessage({
      channel,
      text,
      thread_ts,
    });
    return { ok: result.ok, ts: result.ts };
  },
});

const getChannelHistory = tool({
  name: 'get_channel_history',
  description: 'Get recent messages from a Slack channel',
  parameters: z.object({
    channel: z.string(),
    limit: z.number().default(10),
  }),
  execute: async ({ channel, limit }) => {
    const result = await slack.conversations.history({ channel, limit });
    return result.messages?.map(m => ({
      user: m.user,
      text: m.text,
      ts: m.ts,
    }));
  },
});

const slackBot = new Agent({
  name: 'slack-assistant',
  model: 'ollama/llama3.2',
  instructions: \`You are a helpful Slack assistant. You can:
- Answer questions from team members
- Search channel history for context
- Send messages and replies
Be concise and friendly. Use threads for detailed responses.\`,
  tools: [sendMessage, getChannelHistory],
});

// Handle incoming Slack events
app.post('/slack/events', async (req, res) => {
  const { event } = req.body;

  if (event.type === 'message' && !event.bot_id) {
    const result = await cog.run(slackBot, {
      input: event.text,
      context: { channel: event.channel, user: event.user },
    });
    // Agent will use tools to respond
  }

  res.sendStatus(200);
});`}</CodeBlock>
      </>
    ),

    'data-analyst': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Data Analyst Agent</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">20 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Parse CSV and JSON data</li>
          <li>Perform statistical analysis</li>
          <li>Generate insights and visualizations</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';
import Papa from 'papaparse';

const parseCSV = tool({
  name: 'parse_csv',
  description: 'Parse CSV data and return as JSON',
  parameters: z.object({
    content: z.string().describe('CSV content'),
    hasHeader: z.boolean().default(true),
  }),
  execute: async ({ content, hasHeader }) => {
    const result = Papa.parse(content, { header: hasHeader });
    return {
      data: result.data,
      rowCount: result.data.length,
      columns: hasHeader ? Object.keys(result.data[0] || {}) : [],
    };
  },
});

const analyzeData = tool({
  name: 'analyze_data',
  description: 'Perform statistical analysis on numeric data',
  parameters: z.object({
    data: z.array(z.number()),
    operations: z.array(z.enum(['mean', 'median', 'std', 'min', 'max', 'sum'])),
  }),
  execute: async ({ data, operations }) => {
    const stats: Record<string, number> = {};
    const sorted = [...data].sort((a, b) => a - b);

    if (operations.includes('mean')) {
      stats.mean = data.reduce((a, b) => a + b, 0) / data.length;
    }
    if (operations.includes('median')) {
      const mid = Math.floor(sorted.length / 2);
      stats.median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
    if (operations.includes('min')) stats.min = sorted[0];
    if (operations.includes('max')) stats.max = sorted[sorted.length - 1];
    if (operations.includes('sum')) stats.sum = data.reduce((a, b) => a + b, 0);

    return stats;
  },
});

const generateChart = tool({
  name: 'generate_chart',
  description: 'Generate a chart configuration for visualization',
  parameters: z.object({
    type: z.enum(['bar', 'line', 'pie', 'scatter']),
    title: z.string(),
    labels: z.array(z.string()),
    data: z.array(z.number()),
  }),
  execute: async ({ type, title, labels, data }) => {
    return {
      type,
      data: {
        labels,
        datasets: [{ label: title, data }],
      },
    };
  },
});

const analyst = new Agent({
  name: 'data-analyst',
  model: 'openai/gpt-4o',
  instructions: \`You are a data analyst. Given data:
1. Parse and understand the structure
2. Calculate relevant statistics
3. Identify trends and patterns
4. Generate visualizations when helpful
5. Provide clear, actionable insights\`,
  tools: [parseCSV, analyzeData, generateChart],
});

const result = await cog.run(analyst, {
  input: \`Analyze this sales data and tell me the trends:
Product,Q1,Q2,Q3,Q4
Widget A,100,120,150,180
Widget B,80,75,90,85
Widget C,200,220,210,240\`,
});`}</CodeBlock>
      </>
    ),

    'support-agent': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Customer Support Agent</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">15 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Build a FAQ knowledge base</li>
          <li>Handle escalation to humans</li>
          <li>Track conversation history</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const faqs = [
  { q: 'How do I reset my password?', a: 'Go to Settings > Security > Reset Password' },
  { q: 'What are your business hours?', a: 'We are open 9 AM - 6 PM EST, Monday to Friday' },
  { q: 'How do I cancel my subscription?', a: 'Go to Billing > Manage Subscription > Cancel' },
];

const searchFAQ = tool({
  name: 'search_faq',
  description: 'Search the FAQ knowledge base',
  parameters: z.object({
    query: z.string(),
  }),
  execute: async ({ query }) => {
    // Simple keyword matching - use embeddings in production
    const matches = faqs.filter(faq =>
      faq.q.toLowerCase().includes(query.toLowerCase()) ||
      faq.a.toLowerCase().includes(query.toLowerCase())
    );
    return { results: matches, count: matches.length };
  },
});

const createTicket = tool({
  name: 'create_ticket',
  description: 'Create a support ticket for human follow-up',
  parameters: z.object({
    subject: z.string(),
    description: z.string(),
    priority: z.enum(['low', 'medium', 'high']),
    customerEmail: z.string().email(),
  }),
  execute: async ({ subject, description, priority, customerEmail }) => {
    // Integration with ticketing system
    const ticketId = \`TICKET-\${Date.now()}\`;
    console.log('Created ticket:', { ticketId, subject, priority });
    return { ticketId, status: 'created' };
  },
});

const supportAgent = new Agent({
  name: 'support-agent',
  model: 'ollama/llama3.2',
  instructions: \`You are a friendly customer support agent. Guidelines:
1. First, search the FAQ for answers
2. If FAQ doesn't help, ask clarifying questions
3. For complex issues, create a support ticket
4. Always be polite and empathetic
5. Never make promises you can't keep

If you can't resolve an issue, escalate to a human.\`,
  tools: [searchFAQ, createTicket],
  memory: {
    type: 'conversation',
    maxMessages: 20,
  },
});

// Multi-turn conversation
const session = cog.createSession(supportAgent);

await session.send('Hi, I forgot my password');
// "I can help with that! To reset your password, go to Settings > Security > Reset Password..."

await session.send('That didn\\'t work, I\\'m locked out');
// "I understand that's frustrating. Let me create a ticket for our team to help you..."
// [Creates ticket with high priority]`}</CodeBlock>

        <Callout type="info">
          For production, integrate with a vector database like pgvector for semantic FAQ search.
        </Callout>
      </>
    ),

    workflows: (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">Workflows</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Orchestrate multi-step processes with DAG-based workflows. Handle retries, conditions, and
          human approvals.
        </p>
        <div className="p-6 bg-[#111] border border-[#222] rounded-xl mb-8">
          <pre className="text-[#00ff88] font-mono text-sm">
            {`┌─────────┐     ┌─────────┐     ┌─────────┐
│  START  │────▶│ Agent A │────▶│ Agent B │
└─────────┘     └─────────┘     └────┬────┘
                                     │
                    ┌────────────────┴────────────────┐
                    ▼                                 ▼
              ┌─────────┐                       ┌─────────┐
              │ Agent C │                       │ Agent D │
              └────┬────┘                       └────┬────┘
                   └────────────────┬────────────────┘
                                    ▼
                              ┌─────────┐
                              │   END   │
                              └─────────┘`}
          </pre>
        </div>
      </>
    ),

    'simple-pipeline': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Simple Pipeline</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="easy" />
          <span className="text-[#666] text-sm">10 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Create a sequential workflow</li>
          <li>Pass data between steps</li>
          <li>Execute and monitor progress</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { WorkflowBuilder, WorkflowExecutor, agentNode } from '@cogitator-ai/workflows';
import { Agent } from '@cogitator-ai/core';

// Define agents for each step
const researcher = new Agent({
  name: 'researcher',
  model: 'ollama/llama3.2',
  instructions: 'Research the given topic thoroughly.',
});

const writer = new Agent({
  name: 'writer',
  model: 'ollama/llama3.2',
  instructions: 'Write a clear article based on the research.',
});

const editor = new Agent({
  name: 'editor',
  model: 'ollama/llama3.2',
  instructions: 'Edit and improve the article for clarity and style.',
});

// Build the pipeline workflow
const workflow = new WorkflowBuilder('content-pipeline')
  .addNode(agentNode('research', researcher))
  .addNode(agentNode('write', writer))
  .addNode(agentNode('edit', editor))
  .addEdge('research', 'write')
  .addEdge('write', 'edit')
  .build();

// Execute
const executor = new WorkflowExecutor(workflow, {
  onNodeStart: (nodeId) => console.log(\`Starting: \${nodeId}\`),
  onNodeComplete: (nodeId, result) => console.log(\`Completed: \${nodeId}\`),
});

const result = await executor.run({
  input: 'The future of renewable energy',
});

console.log('Final article:', result.outputs.edit);`}</CodeBlock>

        <Callout type="tip">
          Each node automatically receives the output from its dependencies as input.
        </Callout>
      </>
    ),

    'human-in-loop': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Human-in-the-Loop</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">15 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Add human approval steps</li>
          <li>Handle approval/rejection</li>
          <li>Timeout and fallback behavior</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import {
  WorkflowBuilder,
  WorkflowExecutor,
  agentNode,
  approvalNode,
} from '@cogitator-ai/workflows';

const workflow = new WorkflowBuilder('approval-workflow')
  // Agent generates content
  .addNode(agentNode('generate', contentAgent))

  // Human reviews and approves
  .addNode(approvalNode('review', {
    prompt: 'Please review this content. Approve to publish.',
    timeout: '24h',
    onTimeout: 'reject', // or 'approve', 'escalate'
    notifyChannels: ['slack', 'email'],
  }))

  // Conditional: only publish if approved
  .addNode(agentNode('publish', publisherAgent))

  .addEdge('generate', 'review')
  .addConditionalEdge('review', {
    approved: 'publish',
    rejected: null, // End workflow
  })
  .build();

// Execute with approval handler
const executor = new WorkflowExecutor(workflow, {
  approvalHandler: async (nodeId, context) => {
    // Send to your approval UI
    await sendSlackMessage({
      channel: '#content-review',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: context.prompt } },
        { type: 'section', text: { type: 'mrkdwn', text: context.data } },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: 'Approve', action_id: 'approve' },
            { type: 'button', text: 'Reject', action_id: 'reject' },
          ],
        },
      ],
    });

    // Wait for response (webhook from Slack)
    return await waitForApproval(nodeId);
  },
});

const result = await executor.run({ input: 'Write a blog post about AI' });

if (result.status === 'completed') {
  console.log('Content published!');
} else {
  console.log('Content rejected or timed out');
}`}</CodeBlock>
      </>
    ),

    'parallel-processing': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Parallel Processing</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">15 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Run nodes in parallel</li>
          <li>Fan-out and fan-in patterns</li>
          <li>Aggregate parallel results</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import {
  WorkflowBuilder,
  agentNode,
  functionNode,
  mapNode,
} from '@cogitator-ai/workflows';

// Fan-out: Process multiple items in parallel
const workflow = new WorkflowBuilder('parallel-analysis')
  // Split input into chunks
  .addNode(functionNode('split', async (ctx) => {
    const items = ctx.input.items;
    return { chunks: items };
  }))

  // Process each chunk in parallel (mapNode)
  .addNode(mapNode('analyze', {
    agent: analyzerAgent,
    input: (ctx) => ctx.outputs.split.chunks,
    concurrency: 5, // Max 5 parallel executions
  }))

  // Fan-in: Aggregate results
  .addNode(functionNode('aggregate', async (ctx) => {
    const results = ctx.outputs.analyze;
    return {
      summary: results.map(r => r.output).join('\\n'),
      count: results.length,
    };
  }))

  .addEdge('split', 'analyze')
  .addEdge('analyze', 'aggregate')
  .build();

// Alternative: Explicit parallel branches
const reviewWorkflow = new WorkflowBuilder('parallel-review')
  .addNode(agentNode('security', securityReviewer))
  .addNode(agentNode('performance', perfReviewer))
  .addNode(agentNode('style', styleReviewer))

  // All three run in parallel (no edges between them)
  // Then merge results
  .addNode(functionNode('merge', async (ctx) => {
    return {
      security: ctx.outputs.security,
      performance: ctx.outputs.performance,
      style: ctx.outputs.style,
    };
  }))

  .addEdge('security', 'merge')
  .addEdge('performance', 'merge')
  .addEdge('style', 'merge')
  .build();

const result = await executor.run({
  input: { items: ['item1', 'item2', 'item3', 'item4', 'item5'] },
});`}</CodeBlock>

        <Callout type="info">
          Nodes without dependencies on each other automatically run in parallel.
        </Callout>
      </>
    ),

    'retry-recovery': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Retry & Recovery</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="advanced" />
          <span className="text-[#666] text-sm">20 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Implement retry with exponential backoff</li>
          <li>Use circuit breakers</li>
          <li>Saga pattern with compensation</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import {
  WorkflowBuilder,
  agentNode,
  withRetry,
  withCircuitBreaker,
  withCompensation,
} from '@cogitator-ai/workflows';

const workflow = new WorkflowBuilder('resilient-workflow')
  // Node with retry policy
  .addNode(
    withRetry(
      agentNode('fetch-data', fetchAgent),
      {
        maxAttempts: 3,
        backoff: 'exponential',
        initialDelay: 1000, // 1s, 2s, 4s
        maxDelay: 30000,
        retryOn: ['TIMEOUT', 'RATE_LIMIT'],
      }
    )
  )

  // Node with circuit breaker
  .addNode(
    withCircuitBreaker(
      agentNode('call-api', apiAgent),
      {
        failureThreshold: 5,
        resetTimeout: 60000, // 1 minute
        halfOpenRequests: 3,
        onOpen: () => console.log('Circuit opened!'),
        onClose: () => console.log('Circuit closed'),
      }
    )
  )

  // Saga pattern: compensating transactions
  .addNode(
    withCompensation(
      agentNode('charge-payment', paymentAgent),
      agentNode('refund-payment', refundAgent) // Runs if later steps fail
    )
  )

  .addNode(
    withCompensation(
      agentNode('reserve-inventory', inventoryAgent),
      agentNode('release-inventory', releaseAgent)
    )
  )

  .addNode(agentNode('send-confirmation', emailAgent))

  .addEdge('fetch-data', 'call-api')
  .addEdge('call-api', 'charge-payment')
  .addEdge('charge-payment', 'reserve-inventory')
  .addEdge('reserve-inventory', 'send-confirmation')
  .build();

// If send-confirmation fails, workflow automatically:
// 1. Runs release-inventory
// 2. Runs refund-payment
// 3. Reports failure

const result = await executor.run({ orderId: '12345' });

if (result.status === 'compensated') {
  console.log('Workflow failed, compensations executed:', result.compensations);
}`}</CodeBlock>

        <Callout type="warning">
          Always design compensations carefully. They should be idempotent and safe to retry.
        </Callout>
      </>
    ),

    'scheduled-workflows': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Scheduled Workflows</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">15 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Schedule workflows with cron expressions</li>
          <li>Trigger workflows via webhooks</li>
          <li>Manage scheduled jobs</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import {
  WorkflowBuilder,
  WorkflowScheduler,
  cronTrigger,
  webhookTrigger,
} from '@cogitator-ai/workflows';

const dailyReport = new WorkflowBuilder('daily-report')
  .addNode(agentNode('gather', dataGatherAgent))
  .addNode(agentNode('analyze', analysisAgent))
  .addNode(agentNode('report', reportAgent))
  .addEdge('gather', 'analyze')
  .addEdge('analyze', 'report')
  .build();

const scheduler = new WorkflowScheduler({
  persistence: 'postgres', // or 'redis'
});

// Cron trigger: Run every day at 9 AM
scheduler.schedule(dailyReport, {
  trigger: cronTrigger('0 9 * * *'),
  timezone: 'America/New_York',
  input: { date: '{{now}}' }, // Template variables
  onComplete: async (result) => {
    await sendSlackMessage('#reports', result.outputs.report);
  },
  onError: async (error) => {
    await sendAlert('Daily report failed', error);
  },
});

// Webhook trigger: Run when webhook is called
scheduler.schedule(deployWorkflow, {
  trigger: webhookTrigger({
    path: '/webhooks/deploy',
    method: 'POST',
    secret: process.env.WEBHOOK_SECRET, // HMAC validation
  }),
  input: (req) => ({
    branch: req.body.branch,
    commit: req.body.commit,
  }),
});

// Start the scheduler
await scheduler.start();

// List scheduled workflows
const jobs = await scheduler.list();
console.log('Scheduled jobs:', jobs);

// Pause/resume a job
await scheduler.pause('daily-report');
await scheduler.resume('daily-report');

// Manually trigger
await scheduler.trigger('daily-report', { date: '2024-01-15' });`}</CodeBlock>

        <Callout type="tip">
          Use cron expressions like <code>0 */4 * * *</code> for every 4 hours or{' '}
          <code>0 9 * * 1</code> for every Monday at 9 AM.
        </Callout>
      </>
    ),

    swarms: (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">Swarms</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Coordinate multiple agents working together. Choose from 6 strategies for different
          collaboration patterns.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {[
            { name: 'Hierarchical', desc: 'Supervisor → Workers', icon: '👑' },
            { name: 'Debate', desc: 'Multiple perspectives', icon: '💬' },
            { name: 'Consensus', desc: 'Voting agreement', icon: '🗳️' },
            { name: 'Pipeline', desc: 'Sequential stages', icon: '🔄' },
            { name: 'Auction', desc: 'Bid for tasks', icon: '💰' },
            { name: 'Round-Robin', desc: 'Load balanced', icon: '🔁' },
          ].map((s) => (
            <div key={s.name} className="p-3 bg-[#111] border border-[#222] rounded-lg text-center">
              <div className="text-xl mb-1">{s.icon}</div>
              <div className="text-[#fafafa] font-medium text-sm">{s.name}</div>
              <div className="text-[#666] text-xs">{s.desc}</div>
            </div>
          ))}
        </div>
      </>
    ),

    'hierarchical-team': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Hierarchical Team</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">20 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Create a supervisor-worker pattern</li>
          <li>Delegate tasks to specialized agents</li>
          <li>Aggregate worker results</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Swarm, Agent } from '@cogitator-ai/swarms';

// Supervisor: Project Manager
const pm = new Agent({
  name: 'project-manager',
  model: 'openai/gpt-4o',
  instructions: \`You are a technical project manager. When given a task:
1. Break it down into subtasks
2. Assign each subtask to the appropriate worker
3. Review and integrate their work
4. Deliver a cohesive final result\`,
});

// Workers: Specialized developers
const frontend = new Agent({
  name: 'frontend-dev',
  model: 'ollama/llama3.2',
  instructions: 'You are a React/TypeScript frontend expert.',
  tools: [writeFile, readFile],
});

const backend = new Agent({
  name: 'backend-dev',
  model: 'ollama/llama3.2',
  instructions: 'You are a Node.js/PostgreSQL backend expert.',
  tools: [writeFile, readFile, runSQL],
});

const qa = new Agent({
  name: 'qa-engineer',
  model: 'ollama/llama3.2',
  instructions: 'You write comprehensive tests and find bugs.',
  tools: [runTests, readFile],
});

// Create hierarchical swarm
const devTeam = new Swarm({
  name: 'dev-team',
  strategy: 'hierarchical',
  supervisor: pm,
  workers: [frontend, backend, qa],
  config: {
    maxIterations: 10,
    tokenBudget: 50000,
    workerConcurrency: 2, // Max 2 workers at once
  },
});

const result = await devTeam.run({
  input: 'Build a user authentication system with login, register, and password reset',
});

console.log('Final deliverable:', result.output);
console.log('Worker contributions:', result.workerOutputs);
// {
//   'frontend-dev': 'Created LoginForm, RegisterForm components...',
//   'backend-dev': 'Implemented /api/auth endpoints...',
//   'qa-engineer': 'Added 15 tests with 100% coverage...',
// }`}</CodeBlock>

        <Callout type="tip">
          The supervisor can re-delegate tasks if a worker&apos;s output doesn&apos;t meet
          requirements.
        </Callout>
      </>
    ),

    'debate-swarm': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Debate for Decision Making</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">15 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Set up multi-perspective debate</li>
          <li>Use a moderator for synthesis</li>
          <li>Reach reasoned conclusions</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Swarm, Agent } from '@cogitator-ai/swarms';

// Debaters with different perspectives
const optimist = new Agent({
  name: 'optimist',
  model: 'ollama/llama3.2',
  instructions: 'You see the positive potential in ideas. Argue for benefits and opportunities.',
});

const pessimist = new Agent({
  name: 'skeptic',
  model: 'ollama/llama3.2',
  instructions: 'You identify risks and challenges. Argue against with valid concerns.',
});

const pragmatist = new Agent({
  name: 'pragmatist',
  model: 'ollama/llama3.2',
  instructions: 'You focus on practical implementation. Consider resources and feasibility.',
});

// Moderator synthesizes the debate
const moderator = new Agent({
  name: 'moderator',
  model: 'openai/gpt-4o',
  instructions: \`You moderate debates fairly. Your role:
1. Ensure all perspectives are heard
2. Identify common ground
3. Synthesize arguments into a balanced conclusion
4. Make a final recommendation with reasoning\`,
});

const debateSwarm = new Swarm({
  name: 'decision-debate',
  strategy: 'debate',
  agents: [optimist, pessimist, pragmatist],
  moderator,
  config: {
    maxRounds: 5,
    allowWorkerCommunication: true, // Agents can respond to each other
    synthesizeAfterRounds: 2,
  },
});

const result = await debateSwarm.run({
  input: 'Should we migrate our monolith to microservices?',
});

console.log('Decision:', result.output);
// "After considering all perspectives, the recommendation is to adopt a
//  gradual migration strategy, starting with..."

console.log('Debate history:', result.rounds);
// [
//   { agent: 'optimist', content: 'Microservices offer scalability...' },
//   { agent: 'skeptic', content: 'But the complexity cost is high...' },
//   { agent: 'pragmatist', content: 'A hybrid approach could work...' },
//   ...
// ]`}</CodeBlock>
      </>
    ),

    'consensus-voting': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Consensus Voting</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">15 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Implement voting-based decisions</li>
          <li>Set consensus thresholds</li>
          <li>Handle disagreements</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Swarm, Agent } from '@cogitator-ai/swarms';

// Panel of experts
const experts = [
  new Agent({
    name: 'security-expert',
    model: 'ollama/llama3.2',
    instructions: 'You evaluate code from a security perspective.',
  }),
  new Agent({
    name: 'performance-expert',
    model: 'ollama/llama3.2',
    instructions: 'You evaluate code for performance and efficiency.',
  }),
  new Agent({
    name: 'maintainability-expert',
    model: 'ollama/llama3.2',
    instructions: 'You evaluate code for readability and maintainability.',
  }),
];

const reviewPanel = new Swarm({
  name: 'code-review-panel',
  strategy: 'consensus',
  agents: experts,
  config: {
    threshold: 0.66, // 2/3 must agree
    votingFormat: 'approve_reject_abstain',
    requireJustification: true,
    maxVotingRounds: 3,
    tieBreaker: 'reject', // Default on tie
  },
});

const result = await reviewPanel.run({
  input: \`Review this code change:
\\\`\\\`\\\`typescript
function processPayment(amount: string) {
  return fetch('/api/pay?amount=' + amount);
}
\\\`\\\`\\\`\`,
});

console.log('Verdict:', result.consensus);
// {
//   decision: 'reject',
//   votes: { approve: 0, reject: 3, abstain: 0 },
//   unanimous: true,
// }

console.log('Justifications:', result.justifications);
// [
//   { agent: 'security-expert', vote: 'reject', reason: 'SQL injection vulnerability...' },
//   { agent: 'performance-expert', vote: 'reject', reason: 'String concat is inefficient...' },
//   { agent: 'maintainability-expert', vote: 'reject', reason: 'No error handling...' },
// ]`}</CodeBlock>

        <Callout type="info">
          Consensus works well for code reviews, content moderation, and quality gates.
        </Callout>
      </>
    ),

    'pipeline-assembly': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Pipeline Assembly Line</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="easy" />
          <span className="text-[#666] text-sm">10 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Chain agents sequentially</li>
          <li>Transform data through stages</li>
          <li>Track progress per stage</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Swarm, Agent } from '@cogitator-ai/swarms';

// Content pipeline: raw idea → polished article
const stages = [
  new Agent({
    name: 'researcher',
    model: 'ollama/llama3.2',
    instructions: 'Research the topic and gather key facts and sources.',
  }),
  new Agent({
    name: 'outliner',
    model: 'ollama/llama3.2',
    instructions: 'Create a structured outline from the research.',
  }),
  new Agent({
    name: 'writer',
    model: 'ollama/llama3.2',
    instructions: 'Write a complete draft following the outline.',
  }),
  new Agent({
    name: 'editor',
    model: 'ollama/llama3.2',
    instructions: 'Edit for clarity, grammar, and style.',
  }),
];

const contentPipeline = new Swarm({
  name: 'content-pipeline',
  strategy: 'pipeline',
  agents: stages,
  config: {
    passFullContext: true, // Each stage sees all previous outputs
    stageGates: {
      outliner: (output) => output.includes('##'), // Must have headers
      writer: (output) => output.length > 500, // Min 500 chars
    },
  },
});

const result = await contentPipeline.run({
  input: 'Write an article about the benefits of meditation',
});

console.log('Final article:', result.output);

// Stage-by-stage outputs
result.stageOutputs.forEach((stage, i) => {
  console.log(\`Stage \${i + 1} (\${stages[i].name}): \${stage.duration}ms\`);
});
// Stage 1 (researcher): 2340ms
// Stage 2 (outliner): 1200ms
// Stage 3 (writer): 4500ms
// Stage 4 (editor): 1800ms`}</CodeBlock>
      </>
    ),

    'auction-tasks': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Auction-Based Task Assignment</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="advanced" />
          <span className="text-[#666] text-sm">20 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Agents bid on tasks based on capability</li>
          <li>Optimal task allocation</li>
          <li>Dynamic workload distribution</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Swarm, Agent } from '@cogitator-ai/swarms';

// Specialized agents with different strengths
const agents = [
  new Agent({
    name: 'python-expert',
    model: 'ollama/llama3.2',
    instructions: 'You are an expert in Python and data science.',
    capabilities: ['python', 'pandas', 'numpy', 'ml'],
    costPerToken: 0.001,
  }),
  new Agent({
    name: 'typescript-expert',
    model: 'ollama/llama3.2',
    instructions: 'You are an expert in TypeScript and web development.',
    capabilities: ['typescript', 'react', 'node', 'graphql'],
    costPerToken: 0.001,
  }),
  new Agent({
    name: 'devops-expert',
    model: 'anthropic/claude-3-5-sonnet',
    instructions: 'You are an expert in DevOps and cloud infrastructure.',
    capabilities: ['docker', 'kubernetes', 'aws', 'terraform'],
    costPerToken: 0.015,
  }),
];

const taskPool = new Swarm({
  name: 'task-auction',
  strategy: 'auction',
  agents,
  config: {
    biddingCriteria: [
      'capability_match', // How well agent matches task requirements
      'cost_efficiency',  // Lower cost is better
      'current_load',     // Prefer less busy agents
    ],
    auctionTimeout: 5000, // 5 seconds to bid
    allowNoBids: false,   // Must have at least one bidder
  },
});

const tasks = [
  { id: 1, description: 'Build a pandas data pipeline', requires: ['python', 'pandas'] },
  { id: 2, description: 'Create a React dashboard', requires: ['typescript', 'react'] },
  { id: 3, description: 'Set up Kubernetes deployment', requires: ['kubernetes', 'docker'] },
];

for (const task of tasks) {
  const result = await taskPool.run({
    input: task.description,
    requirements: task.requires,
  });

  console.log(\`Task \${task.id} won by: \${result.winner}\`);
  console.log(\`Bid score: \${result.winningBid.score}\`);
  // Task 1 won by: python-expert (bid score: 0.95)
  // Task 2 won by: typescript-expert (bid score: 0.92)
  // Task 3 won by: devops-expert (bid score: 0.88)
}`}</CodeBlock>

        <Callout type="tip">
          Auction strategy is great for heterogeneous agent pools where different agents have
          different specializations and costs.
        </Callout>
      </>
    ),

    'round-robin': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Round-Robin Load Balancing</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="easy" />
          <span className="text-[#666] text-sm">10 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Distribute tasks evenly across agents</li>
          <li>Handle agent failures</li>
          <li>Scale horizontally</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Swarm, Agent } from '@cogitator-ai/swarms';

// Pool of identical workers
const workers = Array.from({ length: 5 }, (_, i) =>
  new Agent({
    name: \`worker-\${i + 1}\`,
    model: 'ollama/llama3.2',
    instructions: 'You process customer support tickets efficiently.',
  })
);

const supportPool = new Swarm({
  name: 'support-pool',
  strategy: 'round-robin',
  agents: workers,
  config: {
    healthCheck: {
      enabled: true,
      interval: 30000, // Check every 30s
      timeout: 5000,
      unhealthyThreshold: 3, // Remove after 3 failures
    },
    circuitBreaker: {
      enabled: true,
      failureThreshold: 5,
      resetTimeout: 60000,
    },
  },
});

// Process many tickets
const tickets = [
  'How do I reset my password?',
  'My order hasn\\'t arrived',
  'I want a refund',
  'Product is defective',
  'Can\\'t login to my account',
];

const results = await Promise.all(
  tickets.map(ticket =>
    supportPool.run({ input: ticket })
  )
);

// Tasks distributed: worker-1, worker-2, worker-3, worker-4, worker-5

// Check distribution
const distribution = supportPool.getDistribution();
console.log('Task distribution:', distribution);
// { 'worker-1': 1, 'worker-2': 1, 'worker-3': 1, 'worker-4': 1, 'worker-5': 1 }

// Health status
const health = supportPool.getHealth();
console.log('Pool health:', health);
// { healthy: 5, unhealthy: 0, total: 5 }`}</CodeBlock>

        <Callout type="info">
          Round-robin is ideal for stateless tasks where any agent can handle any request.
        </Callout>
      </>
    ),

    reasoning: (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">Advanced Reasoning</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Unlock powerful reasoning capabilities: Tree of Thoughts, self-reflection, learning, and
          more.
        </p>
      </>
    ),

    'tree-of-thoughts': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Tree of Thoughts</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="advanced" />
          <span className="text-[#666] text-sm">20 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Explore multiple reasoning paths simultaneously</li>
          <li>Use beam search for optimal solutions</li>
          <li>Configure branching factor and depth</li>
          <li>Get best solution with confidence scoring</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Cogitator, Agent, ThoughtTreeExecutor } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'problem-solver',
  model: 'ollama/llama3.2',
  instructions: \`You solve complex problems step by step.
When exploring solutions, consider multiple approaches.\`,
});

const cog = new Cogitator();

const tot = new ThoughtTreeExecutor(cog, {
  branchFactor: 3,              // Generate 3 approaches per step
  beamWidth: 2,                 // Keep 2 best paths
  maxDepth: 5,                  // Maximum 5 levels deep
  terminationConfidence: 0.85,  // Stop early if >85% confident
  evaluator: 'self-consistency', // How to rank branches
});

// Solve a complex architectural problem
const result = await tot.explore(
  agent,
  'Design a scalable real-time chat architecture for 10M users'
);

console.log('Best solution:', result.output);
console.log('Confidence:', result.confidence);
console.log('Explored nodes:', result.stats.totalNodes);
console.log('Best path:', result.bestPath);

// View the exploration tree
for (const node of result.explorationTree) {
  console.log(\`Depth \${node.depth}: \${node.thought.substring(0, 50)}...\`);
  console.log(\`  Score: \${node.score}, Children: \${node.children.length}\`);
}`}</CodeBlock>

        <Callout type="tip">
          Tree of Thoughts excels at complex problems where multiple valid approaches exist. Use it
          for architecture design, debugging, and strategic planning.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Custom Evaluator</h3>
        <CodeBlock>{`// Use custom scoring for domain-specific problems
const tot = new ThoughtTreeExecutor(cog, {
  branchFactor: 4,
  beamWidth: 3,
  evaluator: async (thought, context) => {
    // Score based on feasibility, cost, and scalability
    const evaluation = await agent.run({
      input: \`Rate this approach 0-1 on feasibility, cost, scalability:
              \${thought}\`,
    });

    return parseFloat(evaluation.output) || 0.5;
  },
});

// Compare multiple solutions
const comparison = await tot.compareApproaches(
  agent,
  'Implement payment processing',
  ['Stripe integration', 'PayPal integration', 'Custom solution']
);

console.log('Best approach:', comparison.winner);
console.log('Trade-offs:', comparison.tradeoffs);`}</CodeBlock>
      </>
    ),

    'self-reflection': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Self-Reflection</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">15 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Enable agent self-critique</li>
          <li>Accumulate insights over iterations</li>
          <li>Improve responses through reflection</li>
          <li>Track learning progress</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Cogitator, Agent, SelfReflectionExecutor } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'reflective-writer',
  model: 'ollama/llama3.2',
  instructions: 'You write technical content and improve through self-critique.',
});

const cog = new Cogitator();

const reflection = new SelfReflectionExecutor(cog, {
  maxIterations: 3,                    // Max reflection cycles
  minConfidenceThreshold: 0.8,         // Stop when confident
  reflectionPrompt: 'What could be improved? Be specific.',
  insightAccumulation: true,           // Learn from past reflections
});

const result = await reflection.run(agent, {
  input: 'Write a guide on Kubernetes autoscaling',
});

// Output improves with each iteration
console.log('Final output:', result.output);
console.log('Iterations:', result.iterations);
console.log('Confidence:', result.confidence);

// See the reflection journey
for (const step of result.reflectionHistory) {
  console.log(\`--- Iteration \${step.iteration} ---\`);
  console.log('Output:', step.output.substring(0, 100) + '...');
  console.log('Self-critique:', step.critique);
  console.log('Improvements:', step.improvements);
}

// Accumulated insights persist across runs
console.log('Insights learned:', reflection.getInsights());`}</CodeBlock>

        <Callout type="info">
          Self-reflection is perfect for content creation, code review, and any task where iterative
          improvement leads to better quality.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">With Specific Criteria</h3>
        <CodeBlock>{`const reflection = new SelfReflectionExecutor(cog, {
  maxIterations: 5,
  evaluationCriteria: [
    'clarity: Is the explanation easy to understand?',
    'accuracy: Are all technical details correct?',
    'completeness: Are all key points covered?',
    'examples: Are practical examples included?',
  ],
  improvementThreshold: 0.1, // Continue if >10% improvement possible
});

// Subscribe to reflection events
reflection.on('iteration', (data) => {
  console.log(\`Iteration \${data.iteration}: \${data.criteriaScores}\`);
});

reflection.on('insight', (insight) => {
  console.log('New insight:', insight.description);
});

const result = await reflection.run(agent, {
  input: 'Explain how React hooks work',
});`}</CodeBlock>
      </>
    ),

    'agent-learning': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Agent Learning (DSPy-style)</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="advanced" />
          <span className="text-[#666] text-sm">25 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Optimize agent prompts automatically</li>
          <li>Learn from training examples</li>
          <li>Fine-tune few-shot demonstrations</li>
          <li>Evaluate with custom metrics</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Cogitator, Agent, AgentOptimizer } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'sentiment-analyzer',
  model: 'ollama/llama3.2',
  instructions: 'Classify sentiment as positive, negative, or neutral.',
});

const cog = new Cogitator();

// Training data
const trainingSet = [
  { input: 'This product is amazing!', expected: 'positive' },
  { input: 'Terrible experience, never again', expected: 'negative' },
  { input: 'It works as described', expected: 'neutral' },
  { input: 'Best purchase I ever made', expected: 'positive' },
  { input: 'Complete waste of money', expected: 'negative' },
];

const optimizer = new AgentOptimizer(cog, {
  metric: (output, expected) => output.trim().toLowerCase() === expected.toLowerCase() ? 1 : 0,
  maxTrials: 10,
  strategy: 'bootstrap-few-shot', // DSPy-style optimization
});

// Optimize the agent
const optimizedAgent = await optimizer.optimize(agent, trainingSet);

// View what was learned
console.log('Optimized instructions:', optimizedAgent.instructions);
console.log('Selected demonstrations:', optimizer.getSelectedDemos());
console.log('Final accuracy:', optimizer.getBestScore());

// Use the optimized agent
const result = await optimizedAgent.run({
  input: 'Absolutely love this!',
});
console.log('Prediction:', result.output); // positive`}</CodeBlock>

        <Callout type="warning">
          Agent learning requires a good training set. Start with at least 10-20 diverse examples
          for best results.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Advanced Optimization</h3>
        <CodeBlock>{`const optimizer = new AgentOptimizer(cog, {
  // Complex metric with multiple criteria
  metric: async (output, expected, context) => {
    const parsed = JSON.parse(output);
    let score = 0;

    if (parsed.sentiment === expected.sentiment) score += 0.5;
    if (parsed.confidence > 0.8) score += 0.2;
    if (parsed.reasoning.length > 50) score += 0.3;

    return score;
  },

  // Optimization configuration
  maxTrials: 20,
  strategy: 'mipro', // Multi-prompt optimization
  validationSplit: 0.2, // 20% for validation
  earlyStoppingPatience: 3,

  // Track experiments
  experimentTracker: {
    logTo: './optimization-logs',
    saveCheckpoints: true,
  },
});

// Run optimization with cross-validation
const result = await optimizer.optimizeWithCV(agent, fullDataset, {
  folds: 5,
});

console.log('Cross-validation scores:', result.cvScores);
console.log('Best config:', result.bestConfig);

// Export optimized agent
await result.bestAgent.save('./optimized-sentiment-agent');`}</CodeBlock>
      </>
    ),

    'time-travel': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Time-Travel Debug</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="advanced" />
          <span className="text-[#666] text-sm">20 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Create checkpoints during execution</li>
          <li>Replay from any point in history</li>
          <li>Fork execution for A/B testing</li>
          <li>Debug complex agent behaviors</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Cogitator, Agent, TimeTravelExecutor } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'multi-step-agent',
  model: 'ollama/llama3.2',
  instructions: 'You complete complex tasks step by step.',
});

const cog = new Cogitator();

const timeTravel = new TimeTravelExecutor(cog, {
  autoCheckpoint: true,           // Save state after each step
  checkpointInterval: 'per-step', // or 'per-tool-call', 'per-minute'
  maxCheckpoints: 100,
  storage: 'memory',              // or 'file', 'redis'
});

// Execute with automatic checkpointing
const result = await timeTravel.run(agent, {
  input: 'Research, outline, and write a blog post about AI agents',
});

// View execution history
const history = timeTravel.getHistory();
console.log('Steps executed:', history.length);

for (const checkpoint of history) {
  console.log(\`[\${checkpoint.timestamp}] \${checkpoint.action}\`);
  console.log(\`  State: \${JSON.stringify(checkpoint.state).substring(0, 100)}...\`);
}

// Something went wrong? Replay from step 2
const replayed = await timeTravel.replayFrom(2, {
  modifiedInput: 'Research, outline, and write a TECHNICAL blog post',
});

console.log('Replayed result:', replayed.output);`}</CodeBlock>

        <Callout type="tip">
          Time-travel debugging is invaluable for complex multi-step agents. Use it to understand
          failures and test alternative paths.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Fork & Compare</h3>
        <CodeBlock>{`// Fork from a specific checkpoint to test alternatives
const checkpoint5 = timeTravel.getCheckpoint(5);

// Fork A: Continue with one approach
const forkA = await timeTravel.fork(checkpoint5, {
  modifiedContext: { style: 'formal' },
});

// Fork B: Try different approach
const forkB = await timeTravel.fork(checkpoint5, {
  modifiedContext: { style: 'casual' },
});

// Compare the two forks
const comparison = await timeTravel.compare(forkA, forkB, {
  metrics: ['quality', 'speed', 'cost'],
});

console.log('Comparison:', comparison);
// {
//   forkA: { quality: 0.85, speed: 1.2, cost: 0.001 },
//   forkB: { quality: 0.78, speed: 0.8, cost: 0.0008 },
//   winner: 'forkA',
//   reason: 'Higher quality output'
// }

// Interactive debugging
const debugSession = timeTravel.createDebugSession();

debugSession.on('step', (step) => {
  console.log(\`Step \${step.index}: \${step.action}\`);
  // Pause and inspect: debugSession.pause()
  // Step forward: debugSession.stepForward()
  // Step back: debugSession.stepBack()
});

await debugSession.start(agent, { input: 'Complex task...' });`}</CodeBlock>
      </>
    ),

    guardrails: (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Constitutional Guardrails</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">15 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Define constitutional AI principles</li>
          <li>Auto-filter harmful outputs</li>
          <li>Create custom safety rules</li>
          <li>Audit and log violations</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Cogitator, Agent, GuardrailsExecutor } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'helpful-assistant',
  model: 'ollama/llama3.2',
  instructions: 'You are a helpful assistant.',
});

const cog = new Cogitator();

const guardrails = new GuardrailsExecutor(cog, {
  constitution: [
    'Be helpful, harmless, and honest',
    'Never provide instructions for illegal activities',
    'Protect user privacy - never ask for or store personal data',
    'Acknowledge uncertainty rather than guessing',
    'Refuse to generate hateful or discriminatory content',
  ],

  enforcement: 'strict',    // 'strict' | 'warn' | 'log-only'
  onViolation: 'refuse',    // 'refuse' | 'rewrite' | 'flag'
});

// All outputs are checked against constitution
const result = await guardrails.run(agent, {
  input: 'How do I pick a lock?',
});

console.log('Response:', result.output);
// "I can't provide lock-picking instructions. If you're locked out,
// consider calling a professional locksmith."

console.log('Violation detected:', result.violation);
// { rule: 'Never provide instructions for illegal activities',
//   action: 'refused', originalOutput: '...' }`}</CodeBlock>

        <Callout type="warning">
          Always test your guardrails thoroughly. Some edge cases might slip through, so combine
          with content moderation APIs for production.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Custom Rules & Audit</h3>
        <CodeBlock>{`const guardrails = new GuardrailsExecutor(cog, {
  constitution: ['Be helpful and harmless'],

  // Custom rules with handlers
  rules: [
    {
      name: 'no-competitor-mentions',
      pattern: /openai|anthropic|google/i,
      action: 'rewrite',
      rewritePrompt: 'Rephrase without mentioning competitor names',
    },
    {
      name: 'no-price-guarantees',
      check: async (output) => !output.includes('guaranteed'),
      action: 'flag',
    },
    {
      name: 'pii-protection',
      pattern: /\\b\\d{3}-\\d{2}-\\d{4}\\b/, // SSN pattern
      action: 'refuse',
      message: 'Cannot process potential PII',
    },
  ],

  // Audit logging
  audit: {
    enabled: true,
    logPath: './guardrail-logs',
    includeOriginal: true,
    alertOn: ['refuse', 'rewrite'],
    alertWebhook: 'https://your-alert-service.com/webhook',
  },
});

// Subscribe to violations in real-time
guardrails.on('violation', (event) => {
  console.log('Rule violated:', event.rule);
  console.log('Original output:', event.original);
  console.log('Action taken:', event.action);
});

// Get audit summary
const auditSummary = await guardrails.getAuditSummary({
  timeRange: 'last-24h',
});

console.log('Total requests:', auditSummary.total);
console.log('Violations:', auditSummary.violations);
console.log('By rule:', auditSummary.byRule);`}</CodeBlock>
      </>
    ),

    'self-modifying': (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">Self-Modifying Agents</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Agents that evolve at runtime - generating tools, adapting strategies, and optimizing
          their architecture.
        </p>
      </>
    ),

    'auto-generate-tools': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Auto-Generate Tools</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="advanced" />
          <span className="text-[#666] text-sm">20 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Detect when agent needs a missing tool</li>
          <li>Auto-generate tool implementations</li>
          <li>Validate generated tools before use</li>
          <li>Build a self-expanding toolkit</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { SelfModifyingAgent } from '@cogitator-ai/self-modifying';
import { Agent } from '@cogitator-ai/core';

const baseAgent = new Agent({
  name: 'adaptive-assistant',
  model: 'ollama/llama3.2',
  instructions: 'You help with various tasks, requesting new tools when needed.',
});

const selfMod = new SelfModifyingAgent({
  agent: baseAgent,
  config: {
    toolGeneration: {
      enabled: true,
      autoGenerate: true,           // Generate missing tools on-demand
      maxToolsPerSession: 5,        // Limit tool generation
      requireApproval: false,       // Auto-approve (or set to true for review)
      sandbox: 'wasm',              // Execute in sandbox for safety
    },
  },
});

// Agent will generate a tool if it doesn't exist
const result = await selfMod.run({
  input: 'Calculate the Fibonacci sequence up to 100',
});

// Check what tools were generated
const generatedTools = selfMod.getGeneratedTools();
console.log('Generated tools:', generatedTools);
// [{
//   name: 'fibonacci',
//   description: 'Calculate Fibonacci sequence',
//   implementation: 'function fibonacci(n) { ... }',
//   generatedAt: '2024-01-15T10:30:00Z'
// }]

// The tool is now available for future use
console.log('Current tools:', selfMod.listTools());`}</CodeBlock>

        <Callout type="warning">
          Auto-generated tools run in a sandbox by default. Always review generated code before
          enabling unsandboxed execution.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">With Approval Flow</h3>
        <CodeBlock>{`const selfMod = new SelfModifyingAgent({
  agent: baseAgent,
  config: {
    toolGeneration: {
      enabled: true,
      autoGenerate: true,
      requireApproval: true,  // Human must approve
    },
  },
});

// Listen for tool generation requests
selfMod.on('tool_generation_requested', async (event) => {
  console.log('Tool requested:', event.data.name);
  console.log('Description:', event.data.description);
  console.log('Implementation:', event.data.implementation);

  // Review and approve/reject
  const approved = await promptUser('Approve this tool?');

  if (approved) {
    await selfMod.approveTool(event.data.id);
  } else {
    await selfMod.rejectTool(event.data.id, 'Security concerns');
  }
});

selfMod.on('tool_generation_completed', (event) => {
  console.log('Tool ready:', event.data.name);
});

// Persist generated tools for future sessions
await selfMod.saveTools('./generated-tools.json');

// Load previously generated tools
await selfMod.loadTools('./generated-tools.json');`}</CodeBlock>
      </>
    ),

    'meta-reasoning': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Meta-Reasoning Modes</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="advanced" />
          <span className="text-[#666] text-sm">15 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Switch between reasoning modes dynamically</li>
          <li>Configure automatic mode triggers</li>
          <li>Use analytical vs creative modes</li>
          <li>Handle mode transitions gracefully</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { SelfModifyingAgent, ReasoningMode } from '@cogitator-ai/self-modifying';
import { Agent } from '@cogitator-ai/core';

const baseAgent = new Agent({
  name: 'flexible-thinker',
  model: 'ollama/llama3.2',
  instructions: 'You adapt your thinking style to the task at hand.',
});

const selfMod = new SelfModifyingAgent({
  agent: baseAgent,
  config: {
    metaReasoning: {
      enabled: true,
      defaultMode: 'analytical',

      // Available modes
      modes: {
        analytical: {
          temperature: 0.2,
          instructions: 'Think step by step. Be precise and logical.',
          maxTokens: 2000,
        },
        creative: {
          temperature: 0.9,
          instructions: 'Think outside the box. Explore unusual ideas.',
          maxTokens: 3000,
        },
        cautious: {
          temperature: 0.1,
          instructions: 'Double-check everything. Prioritize accuracy.',
          maxTokens: 1500,
        },
      },

      // Auto-switch triggers
      triggers: [
        {
          event: 'on_failure',
          switchTo: 'cautious',
          condition: (ctx) => ctx.errorCount > 1,
        },
        {
          event: 'on_low_confidence',
          switchTo: 'analytical',
          threshold: 0.5,
        },
        {
          event: 'on_creative_task',
          switchTo: 'creative',
          keywords: ['brainstorm', 'creative', 'ideas', 'imagine'],
        },
      ],
    },
  },
});

// Start in analytical mode
let result = await selfMod.run({
  input: 'Calculate the optimal route between 5 cities',
});
console.log('Mode used:', selfMod.getCurrentMode()); // analytical

// This triggers creative mode automatically
result = await selfMod.run({
  input: 'Brainstorm 10 creative marketing campaign ideas',
});
console.log('Mode used:', selfMod.getCurrentMode()); // creative

// Manual mode switch
selfMod.setMode('cautious');
result = await selfMod.run({
  input: 'Review this financial report for errors',
});`}</CodeBlock>

        <Callout type="tip">
          Meta-reasoning lets agents adapt their thinking style. Use analytical for math/logic,
          creative for brainstorming, and cautious for high-stakes tasks.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Mode Transition Events</h3>
        <CodeBlock>{`// Monitor mode transitions
selfMod.on('mode_transition', (event) => {
  console.log(\`Mode changed: \${event.from} → \${event.to}\`);
  console.log('Reason:', event.reason);
  console.log('Context:', event.context);
});

// Custom mode selection logic
selfMod.setModeSelector(async (input, context) => {
  // Analyze input to determine best mode
  const analysis = await selfMod.analyze(input);

  if (analysis.requiresCreativity > 0.7) return 'creative';
  if (analysis.requiresPrecision > 0.8) return 'analytical';
  if (analysis.riskLevel > 0.5) return 'cautious';

  return 'analytical'; // default
});

// Get mode history
const history = selfMod.getModeHistory();
console.log('Mode transitions:', history);
// [
//   { mode: 'analytical', duration: 5000, tasks: 1 },
//   { mode: 'creative', duration: 12000, tasks: 1 },
//   { mode: 'cautious', duration: 8000, tasks: 1 },
// ]`}</CodeBlock>
      </>
    ),

    'architecture-evolution': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Architecture Evolution</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="advanced" />
          <span className="text-[#666] text-sm">20 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Optimize agent architecture automatically</li>
          <li>Use UCB (Upper Confidence Bound) for exploration</li>
          <li>Track performance across configurations</li>
          <li>Evolve agent structure over time</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { SelfModifyingAgent, ArchitectureOptimizer } from '@cogitator-ai/self-modifying';
import { Agent } from '@cogitator-ai/core';

const baseAgent = new Agent({
  name: 'evolving-agent',
  model: 'ollama/llama3.2',
  instructions: 'You complete tasks efficiently.',
});

const selfMod = new SelfModifyingAgent({
  agent: baseAgent,
  config: {
    architectureEvolution: {
      enabled: true,
      optimizer: 'ucb',  // Upper Confidence Bound algorithm
      explorationWeight: 0.5,

      // Parameters to optimize
      searchSpace: {
        temperature: { min: 0.1, max: 1.0, step: 0.1 },
        maxTokens: { values: [500, 1000, 2000, 4000] },
        systemPromptLength: { min: 100, max: 500, step: 50 },
        toolCount: { min: 1, max: 10, step: 1 },
      },

      // How to evaluate configurations
      metrics: ['quality', 'speed', 'cost'],
      evaluator: async (result, config) => {
        return {
          quality: result.confidence,
          speed: 1 / result.latency,
          cost: 1 - (result.tokensUsed / 4000),
        };
      },
    },
  },
});

// Run multiple iterations to optimize
for (let i = 0; i < 50; i++) {
  const result = await selfMod.run({
    input: 'Summarize this article: ...',
  });

  console.log(\`Iteration \${i}: Config = \${JSON.stringify(selfMod.getCurrentConfig())}\`);
  console.log(\`  Score: \${result.optimizationScore}\`);
}

// View the best configuration found
const best = selfMod.getBestConfig();
console.log('Best configuration:', best.config);
console.log('Best scores:', best.scores);

// Lock in the best config
selfMod.lockConfig(best.config);`}</CodeBlock>

        <Callout type="info">
          Architecture evolution uses bandit algorithms to balance exploration (trying new configs)
          with exploitation (using known good configs).
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Multi-Objective Optimization</h3>
        <CodeBlock>{`const selfMod = new SelfModifyingAgent({
  agent: baseAgent,
  config: {
    architectureEvolution: {
      enabled: true,
      optimizer: 'pareto',  // Multi-objective optimization

      objectives: {
        quality: { weight: 0.5, direction: 'maximize' },
        speed: { weight: 0.3, direction: 'maximize' },
        cost: { weight: 0.2, direction: 'minimize' },
      },

      // Population-based optimization
      populationSize: 10,
      generations: 20,
      mutationRate: 0.1,
      crossoverRate: 0.7,
    },
  },
});

// Get Pareto frontier of optimal configurations
const paretoFront = selfMod.getParetoFront();
console.log('Pareto optimal configs:', paretoFront);
// [
//   { config: {...}, quality: 0.95, speed: 0.6, cost: 0.8 },
//   { config: {...}, quality: 0.85, speed: 0.9, cost: 0.7 },
//   { config: {...}, quality: 0.75, speed: 0.95, cost: 0.5 },
// ]

// Choose config based on your priorities
const fastConfig = paretoFront.find(c => c.speed > 0.9);
selfMod.setConfig(fastConfig.config);

// Export evolution history for analysis
await selfMod.exportEvolutionHistory('./evolution-log.json');`}</CodeBlock>
      </>
    ),

    causal: (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">Causal Reasoning</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Pearl&apos;s Ladder of Causation: association, intervention, and counterfactual reasoning.
        </p>
      </>
    ),

    'root-cause': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Root Cause Analysis</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="advanced" />
          <span className="text-[#666] text-sm">20 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Build causal graphs from domain knowledge</li>
          <li>Trace causes back from observed effects</li>
          <li>Identify confounders and mediators</li>
          <li>Generate actionable explanations</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { CausalReasoner, CausalGraphBuilder } from '@cogitator-ai/causal';
import { Cogitator } from '@cogitator-ai/core';

const cog = new Cogitator();
const llm = cog.getDefaultBackend();

// Build a causal graph for system failures
const graph = CausalGraphBuilder.create('system-failure')
  // Define nodes
  .treatment('high_load', 'High Server Load')
  .outcome('timeout', 'Request Timeout')
  .confounder('memory_leak', 'Memory Leak')
  .mediator('slow_db', 'Slow Database')

  // Define causal relationships
  .from('memory_leak').causes('high_load', { strength: 0.8 })
  .from('high_load').causes('slow_db', { strength: 0.7 })
  .from('slow_db').causes('timeout', { strength: 0.9 })
  .from('memory_leak').causes('timeout', { strength: 0.4 })
  .build();

const reasoner = new CausalReasoner({ llmBackend: llm });
await reasoner.loadGraph(graph);

// Analyze root causes of timeouts
const analysis = await reasoner.explainCause('timeout', 0.9, {
  observations: {
    timeout: true,
    high_load: true,
    slow_db: true,
  },
});

console.log('Root causes:', analysis.rootCauses);
// [
//   { variable: 'memory_leak', contribution: 0.72, confidence: 0.85 },
//   { variable: 'high_load', contribution: 0.63, confidence: 0.78 },
// ]

console.log('Causal path:', analysis.causalPath);
// memory_leak → high_load → slow_db → timeout

console.log('Explanation:', analysis.explanation);
// "The timeout is primarily caused by a memory leak (72% contribution)
//  which leads to high server load, slowing the database."`}</CodeBlock>

        <Callout type="tip">
          Root cause analysis is perfect for debugging production issues, understanding system
          failures, and explaining complex behaviors.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">
          Interactive Root Cause Discovery
        </h3>
        <CodeBlock>{`// Discover causal structure from data + LLM reasoning
const reasoner = new CausalReasoner({ llmBackend: llm });

// Learn causal structure from observations
const discoveredGraph = await reasoner.discoverStructure({
  variables: ['load', 'memory', 'latency', 'errors', 'timeout'],
  data: historicalMetrics,  // Time series data
  priorKnowledge: [
    'memory issues cause high load',
    'high latency precedes timeouts',
  ],
});

console.log('Discovered relationships:', discoveredGraph.edges);

// Generate intervention recommendations
const recommendations = await reasoner.recommendInterventions('timeout', {
  maxInterventions: 3,
  costFunction: (intervention) => intervention.difficulty,
});

console.log('Recommended fixes:');
for (const rec of recommendations) {
  console.log(\`- \${rec.action}: \${rec.expectedImpact}% reduction\`);
  console.log(\`  Difficulty: \${rec.difficulty}, Confidence: \${rec.confidence}\`);
}
// - Fix memory leak: 72% reduction (High confidence)
// - Add database caching: 45% reduction (Medium confidence)
// - Scale horizontally: 30% reduction (High confidence)`}</CodeBlock>
      </>
    ),

    'effect-prediction': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Effect Prediction (What-if)</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="advanced" />
          <span className="text-[#666] text-sm">15 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Predict effects of interventions</li>
          <li>Simulate do-calculus operations</li>
          <li>Compare intervention strategies</li>
          <li>Quantify expected outcomes</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { CausalReasoner, CausalGraphBuilder } from '@cogitator-ai/causal';
import { Cogitator } from '@cogitator-ai/core';

const cog = new Cogitator();
const llm = cog.getDefaultBackend();

// Marketing campaign causal model
const graph = CausalGraphBuilder.create('marketing')
  .variable('ad_spend', 'Advertising Budget')
  .variable('brand_awareness', 'Brand Awareness')
  .variable('website_traffic', 'Website Traffic')
  .variable('conversions', 'Conversions')
  .variable('revenue', 'Revenue')
  .confounder('seasonality', 'Seasonal Effects')

  .from('ad_spend').causes('brand_awareness', { strength: 0.6 })
  .from('ad_spend').causes('website_traffic', { strength: 0.5 })
  .from('brand_awareness').causes('website_traffic', { strength: 0.4 })
  .from('website_traffic').causes('conversions', { strength: 0.7 })
  .from('conversions').causes('revenue', { strength: 0.9 })
  .from('seasonality').causes('conversions', { strength: 0.3 })
  .build();

const reasoner = new CausalReasoner({ llmBackend: llm });
await reasoner.loadGraph(graph);

// What if we increase ad spend by 50%?
const prediction = await reasoner.predictIntervention({
  intervention: { ad_spend: 1.5 },  // 50% increase
  target: 'revenue',
  baseline: currentMetrics,
});

console.log('Predicted revenue change:', prediction.effect);
// { absolute: +$45,000, relative: +23%, confidence: 0.78 }

console.log('Causal pathways:');
for (const pathway of prediction.pathways) {
  console.log(\`  \${pathway.path.join(' → ')}: \${pathway.contribution}%\`);
}
// ad_spend → website_traffic → conversions → revenue: 60%
// ad_spend → brand_awareness → website_traffic → conversions → revenue: 40%`}</CodeBlock>

        <Callout type="info">
          Effect prediction answers &quot;What will happen if we do X?&quot; - essential for
          decision-making and planning.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">
          Compare Multiple Interventions
        </h3>
        <CodeBlock>{`// Compare different strategies
const strategies = [
  { name: 'Increase Ads', intervention: { ad_spend: 1.5 } },
  { name: 'Improve Conversion', intervention: { conversion_rate: 1.2 } },
  { name: 'Combined', intervention: { ad_spend: 1.3, conversion_rate: 1.1 } },
];

const comparison = await reasoner.compareInterventions(strategies, {
  target: 'revenue',
  baseline: currentMetrics,
  constraints: {
    budget: 100000,
    timeframe: '3 months',
  },
});

console.log('Strategy comparison:');
console.log(comparison.ranking);
// [
//   { name: 'Combined', roi: 2.3, risk: 'medium', confidence: 0.72 },
//   { name: 'Improve Conversion', roi: 1.8, risk: 'low', confidence: 0.85 },
//   { name: 'Increase Ads', roi: 1.5, risk: 'medium', confidence: 0.78 },
// ]

console.log('Recommendation:', comparison.recommendation);
// "Combined strategy offers best ROI but with medium risk.
//  Consider 'Improve Conversion' for lower risk option."

// Sensitivity analysis
const sensitivity = await reasoner.sensitivityAnalysis({
  intervention: { ad_spend: 1.5 },
  target: 'revenue',
  varyBy: ['seasonality', 'competition'],
});

console.log('Sensitivity:', sensitivity);
// { seasonality: 'high', competition: 'medium' }
// Effect varies significantly with seasonal changes`}</CodeBlock>
      </>
    ),

    counterfactual: (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Counterfactual Reasoning</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="advanced" />
          <span className="text-[#666] text-sm">20 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Answer &quot;What would have happened if...?&quot; questions</li>
          <li>Reason about alternative scenarios</li>
          <li>Attribute outcomes to specific causes</li>
          <li>Generate counterfactual explanations</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { CausalReasoner, CausalGraphBuilder } from '@cogitator-ai/causal';
import { Cogitator } from '@cogitator-ai/core';

const cog = new Cogitator();
const llm = cog.getDefaultBackend();

// Loan approval causal model
const graph = CausalGraphBuilder.create('loan-decision')
  .variable('income', 'Annual Income')
  .variable('credit_score', 'Credit Score')
  .variable('debt_ratio', 'Debt-to-Income Ratio')
  .variable('employment', 'Employment Status')
  .variable('approved', 'Loan Approved')

  .from('income').causes('debt_ratio', { strength: -0.6 })
  .from('income').causes('approved', { strength: 0.4 })
  .from('credit_score').causes('approved', { strength: 0.5 })
  .from('debt_ratio').causes('approved', { strength: -0.3 })
  .from('employment').causes('approved', { strength: 0.3 })
  .build();

const reasoner = new CausalReasoner({ llmBackend: llm });
await reasoner.loadGraph(graph);

// Application was denied - what would have changed the outcome?
const factual = {
  income: 50000,
  credit_score: 620,
  debt_ratio: 0.45,
  employment: 'part-time',
  approved: false,
};

const counterfactual = await reasoner.counterfactual({
  factual,
  target: 'approved',
  desiredOutcome: true,
});

console.log('Counterfactual scenarios:');
for (const scenario of counterfactual.scenarios) {
  console.log(\`If \${scenario.change}:\`);
  console.log(\`  Outcome would be: \${scenario.outcome}\`);
  console.log(\`  Probability: \${scenario.probability}\`);
}
// If credit_score had been 700 (instead of 620):
//   Outcome would be: approved
//   Probability: 0.78
//
// If debt_ratio had been 0.30 (instead of 0.45):
//   Outcome would be: approved
//   Probability: 0.65

console.log('Minimal change needed:', counterfactual.minimalChange);
// { credit_score: 680 } - smallest change for approval`}</CodeBlock>

        <Callout type="tip">
          Counterfactual reasoning is powerful for explaining AI decisions, finding minimal
          interventions, and understanding &quot;near misses&quot;.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Attribution & Explanation</h3>
        <CodeBlock>{`// Attribute outcome to specific factors
const attribution = await reasoner.attributeOutcome({
  observation: {
    income: 80000,
    credit_score: 750,
    debt_ratio: 0.25,
    employment: 'full-time',
    approved: true,
  },
  target: 'approved',
});

console.log('Outcome attribution:');
console.log(attribution.contributions);
// {
//   credit_score: 0.35,  // 35% contribution to approval
//   income: 0.28,
//   debt_ratio: 0.22,
//   employment: 0.15,
// }

// Generate human-readable explanation
const explanation = await reasoner.explainDecision({
  observation: factual,
  target: 'approved',
  style: 'user-friendly',
});

console.log('Explanation:', explanation.text);
// "Your loan application was not approved primarily due to your
//  credit score (620). If your credit score had been at least 680,
//  you would likely have been approved. Improving your debt-to-income
//  ratio from 45% to 30% would also significantly help."

// Necessary vs sufficient causes
const causes = await reasoner.analyzeCausality({
  observation: factual,
  target: 'approved',
});

console.log('Necessary causes:', causes.necessary);
// [{ factor: 'credit_score', necessity: 0.92 }]

console.log('Sufficient causes:', causes.sufficient);
// [{ factors: ['credit_score', 'income'], sufficiency: 0.85 }]`}</CodeBlock>
      </>
    ),

    'neuro-symbolic': (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">Neuro-Symbolic</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Combine neural networks with symbolic reasoning: logic programming, constraint solving,
          and plan verification.
        </p>
      </>
    ),

    'logic-programming': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Logic Programming (Prolog-style)</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="advanced" />
          <span className="text-[#666] text-sm">20 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Define facts and rules in Prolog-style syntax</li>
          <li>Query knowledge bases with logical inference</li>
          <li>Combine LLM reasoning with symbolic logic</li>
          <li>Build explainable reasoning chains</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { NeuroSymbolicEngine, LogicProgram } from '@cogitator-ai/neuro-symbolic';
import { Cogitator } from '@cogitator-ai/core';

const cog = new Cogitator();
const llm = cog.getDefaultBackend();

const engine = new NeuroSymbolicEngine({ llmBackend: llm });

// Define a knowledge base in Prolog-style syntax
const program = LogicProgram.parse(\`
  % Facts
  parent(tom, mary).
  parent(tom, john).
  parent(mary, ann).
  parent(mary, pat).
  parent(pat, jim).

  % Rules
  grandparent(X, Z) :- parent(X, Y), parent(Y, Z).
  ancestor(X, Y) :- parent(X, Y).
  ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
  sibling(X, Y) :- parent(Z, X), parent(Z, Y), X \\= Y.
\`);

await engine.loadProgram(program);

// Query the knowledge base
const result = await engine.query('grandparent(tom, X)');
console.log('Tom\\'s grandchildren:', result.solutions);
// [{ X: 'ann' }, { X: 'pat' }]

// More complex query with explanation
const ancestors = await engine.query('ancestor(tom, jim)', {
  explain: true,
});

console.log('Is Tom an ancestor of Jim?', ancestors.success);
// true

console.log('Proof:', ancestors.explanation);
// tom is parent of mary
// mary is parent of pat
// pat is parent of jim
// Therefore, tom is ancestor of jim`}</CodeBlock>

        <Callout type="info">
          Logic programming provides guaranteed correctness for rule-based reasoning, while LLMs
          handle natural language understanding and ambiguity.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">
          LLM-Assisted Knowledge Extraction
        </h3>
        <CodeBlock>{`// Let LLM extract facts from natural language
const facts = await engine.extractFacts(\`
  Alice is Bob's mother. Bob has a sister named Carol.
  Carol's son is David. David is married to Eve.
\`);

console.log('Extracted facts:', facts);
// [
//   'parent(alice, bob)',
//   'parent(alice, carol)',
//   'sibling(bob, carol)',
//   'parent(carol, david)',
//   'married(david, eve)',
// ]

await engine.addFacts(facts);

// Query using natural language (LLM translates to Prolog)
const answer = await engine.askNaturalLanguage(
  'Who is David\\'s grandmother?'
);

console.log('Answer:', answer.result);  // alice
console.log('Query used:', answer.query); // grandparent(X, david)
console.log('Reasoning:', answer.explanation);

// Validate LLM output against logic rules
const validation = await engine.validateWithRules(\`
  The system should recommend Alice for the job because she has
  5 years experience and a relevant degree.
\`, {
  rules: \`
    recommend(X) :- experience(X, Y), Y >= 3, has_degree(X).
    qualified(X) :- recommend(X).
  \`,
  facts: ['experience(alice, 5)', 'has_degree(alice)'],
});

console.log('Valid conclusion:', validation.valid);  // true
console.log('Proof:', validation.proof);`}</CodeBlock>
      </>
    ),

    'constraint-solving': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Constraint Solving (SAT/SMT)</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="advanced" />
          <span className="text-[#666] text-sm">20 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Define constraint satisfaction problems</li>
          <li>Solve scheduling and optimization problems</li>
          <li>Use LLM to formulate constraints from natural language</li>
          <li>Verify solutions meet all requirements</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { ConstraintSolver, Variable, Constraint } from '@cogitator-ai/neuro-symbolic';
import { Cogitator } from '@cogitator-ai/core';

const cog = new Cogitator();
const llm = cog.getDefaultBackend();

const solver = new ConstraintSolver({ llmBackend: llm });

// Define a scheduling problem
const problem = solver.defineProblem({
  variables: {
    meeting_a: { domain: [9, 10, 11, 14, 15, 16] },
    meeting_b: { domain: [9, 10, 11, 14, 15, 16] },
    meeting_c: { domain: [9, 10, 11, 14, 15, 16] },
    lunch: { domain: [12, 13] },
  },

  constraints: [
    // Meetings can't overlap
    { type: 'allDifferent', variables: ['meeting_a', 'meeting_b', 'meeting_c'] },

    // Meeting A must be before Meeting B
    { type: 'lessThan', left: 'meeting_a', right: 'meeting_b' },

    // Meeting C must be in the afternoon
    { type: 'greaterThanOrEqual', variable: 'meeting_c', value: 14 },

    // At least 1 hour gap between meetings
    { type: 'custom', fn: (vars) => Math.abs(vars.meeting_a - vars.meeting_b) >= 2 },
  ],
});

const solution = await solver.solve(problem);

console.log('Schedule:', solution);
// {
//   meeting_a: 9,
//   meeting_b: 11,
//   meeting_c: 14,
//   lunch: 12
// }

// Get all valid solutions
const allSolutions = await solver.solveAll(problem, { maxSolutions: 10 });
console.log(\`Found \${allSolutions.length} valid schedules\`);`}</CodeBlock>

        <Callout type="tip">
          Constraint solving guarantees valid solutions. Use it for scheduling, resource allocation,
          configuration, and any problem with hard requirements.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Natural Language Constraints</h3>
        <CodeBlock>{`// Let LLM translate natural language to constraints
const nlProblem = await solver.fromNaturalLanguage(\`
  Schedule a team meeting with these constraints:
  - Alice is available 9-12 and 14-17
  - Bob is available 10-15
  - Carol is available 9-11 and 15-17
  - The meeting needs 2 hours
  - Prefer morning slots if possible

  Also schedule a 1-on-1 with David:
  - David is available 11-16
  - Can't overlap with team meeting
  - Needs 1 hour
\`);

console.log('Extracted constraints:', nlProblem.constraints);

const schedule = await solver.solve(nlProblem, {
  optimize: 'prefer_morning',  // Soft constraint
});

console.log('Optimal schedule:', schedule);
// { team_meeting: { start: 10, end: 12 }, david_1on1: { start: 14, end: 15 } }

// Explain why certain times don't work
const explanation = await solver.explainInfeasibility({
  ...nlProblem,
  constraints: [
    ...nlProblem.constraints,
    { type: 'equals', variable: 'team_meeting_start', value: 9 },
  ],
});

console.log('Why 9am doesn\\'t work:', explanation);
// "A 9am start doesn't work because Bob isn't available until 10am
//  and the meeting requires all participants."`}</CodeBlock>
      </>
    ),

    'plan-verification': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Plan Verification</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="advanced" />
          <span className="text-[#666] text-sm">15 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Verify agent plans before execution</li>
          <li>Check preconditions and postconditions</li>
          <li>Detect invalid action sequences</li>
          <li>Suggest plan corrections</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { PlanVerifier, ActionSchema } from '@cogitator-ai/neuro-symbolic';
import { Cogitator, Agent } from '@cogitator-ai/core';

const cog = new Cogitator();
const llm = cog.getDefaultBackend();

// Define action schemas with preconditions and effects
const actions: ActionSchema[] = [
  {
    name: 'pickup',
    parameters: ['object', 'location'],
    preconditions: ['at(agent, location)', 'at(object, location)', 'hand_empty()'],
    effects: ['holding(object)', 'not(at(object, location))', 'not(hand_empty())'],
  },
  {
    name: 'putdown',
    parameters: ['object', 'location'],
    preconditions: ['at(agent, location)', 'holding(object)'],
    effects: ['at(object, location)', 'not(holding(object))', 'hand_empty()'],
  },
  {
    name: 'move',
    parameters: ['from', 'to'],
    preconditions: ['at(agent, from)', 'connected(from, to)'],
    effects: ['at(agent, to)', 'not(at(agent, from))'],
  },
];

const verifier = new PlanVerifier({
  llmBackend: llm,
  actions,
  worldModel: {
    initial: [
      'at(agent, room_a)',
      'at(box, room_b)',
      'connected(room_a, room_b)',
      'connected(room_b, room_a)',
      'hand_empty()',
    ],
    goal: ['at(box, room_a)'],
  },
});

// Verify a proposed plan
const plan = [
  { action: 'move', params: ['room_a', 'room_b'] },
  { action: 'pickup', params: ['box', 'room_b'] },
  { action: 'move', params: ['room_b', 'room_a'] },
  { action: 'putdown', params: ['box', 'room_a'] },
];

const verification = await verifier.verify(plan);

console.log('Plan valid:', verification.valid);  // true
console.log('Goal achieved:', verification.goalAchieved);  // true
console.log('State trace:', verification.stateTrace);`}</CodeBlock>

        <Callout type="warning">
          Plan verification catches errors before execution. Always verify agent-generated plans for
          critical operations.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Automatic Plan Repair</h3>
        <CodeBlock>{`// Invalid plan - tries to pickup without moving first
const invalidPlan = [
  { action: 'pickup', params: ['box', 'room_b'] },  // Error: agent not at room_b
  { action: 'move', params: ['room_a', 'room_b'] },
];

const result = await verifier.verify(invalidPlan);

console.log('Plan valid:', result.valid);  // false
console.log('Error at step:', result.errorStep);  // 0
console.log('Error:', result.error);
// "Precondition 'at(agent, room_b)' not satisfied. Agent is at room_a."

// Automatically repair the plan
const repairedPlan = await verifier.repair(invalidPlan);

console.log('Repaired plan:', repairedPlan.plan);
// [
//   { action: 'move', params: ['room_a', 'room_b'] },
//   { action: 'pickup', params: ['box', 'room_b'] },
// ]

console.log('Changes made:', repairedPlan.changes);
// ['Inserted move(room_a, room_b) before pickup']

// Integrate with agent execution
const agent = new Agent({
  name: 'planner',
  model: 'ollama/llama3.2',
  instructions: 'You create plans to achieve goals.',
});

const wrappedAgent = verifier.wrapAgent(agent, {
  autoRepair: true,
  onInvalidPlan: (plan, error) => {
    console.log('Agent generated invalid plan:', error);
  },
});

// Agent's plans are automatically verified and repaired
const safeResult = await wrappedAgent.run({
  input: 'Move the box from room B to room A',
});`}</CodeBlock>
      </>
    ),

    memory: (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">Memory & RAG</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Give your agents persistent memory with conversation history, semantic search, and
          long-term recall.
        </p>
      </>
    ),

    'conversation-memory': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Conversation Memory</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="easy" />
          <span className="text-[#666] text-sm">10 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Store and retrieve conversation history</li>
          <li>Use sliding window for context management</li>
          <li>Summarize long conversations</li>
          <li>Persist memory across sessions</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Agent, ConversationMemory } from '@cogitator-ai/core';
import { MemoryStore } from '@cogitator-ai/memory';

// Create memory store (in-memory, Redis, SQLite, etc.)
const store = new MemoryStore({
  type: 'sqlite',
  path: './agent-memory.db',
});

const memory = new ConversationMemory({
  store,
  maxMessages: 50,           // Keep last 50 messages
  summarizeAfter: 30,        // Summarize when exceeding 30
  summaryModel: 'ollama/llama3.2',
});

const agent = new Agent({
  name: 'assistant',
  model: 'ollama/llama3.2',
  memory,  // Attach memory to agent
  instructions: 'You are a helpful assistant with memory of past conversations.',
});

// First conversation
await agent.run({ input: 'My name is Alice and I love hiking.' });
await agent.run({ input: 'What activities do you recommend?' });

// Later conversation - agent remembers context
const response = await agent.run({
  input: 'What was my name again?',
});
console.log(response.output);
// "Your name is Alice! And based on our earlier conversation,
//  you mentioned you love hiking."

// View conversation history
const history = await memory.getHistory();
console.log('Messages:', history.messages.length);
console.log('Summary:', history.summary);

// Clear memory for new session
await memory.clear();`}</CodeBlock>

        <Callout type="tip">
          Use conversation memory for chatbots, support agents, and any agent that needs to maintain
          context across multiple interactions.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Session Management</h3>
        <CodeBlock>{`const memory = new ConversationMemory({
  store,
  sessionId: 'user-123',  // Separate memory per user/session
});

// Create new session
const session = await memory.createSession({
  userId: 'user-456',
  metadata: { source: 'web', language: 'en' },
});

// Switch between sessions
await memory.loadSession(session.id);

// List all sessions for a user
const sessions = await memory.listSessions({ userId: 'user-456' });
console.log('Sessions:', sessions);

// Export conversation for analysis
const exported = await memory.export({
  format: 'json',
  includeMetadata: true,
});

// Import previous conversation
await memory.import(previousConversation);`}</CodeBlock>
      </>
    ),

    'semantic-search': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Semantic Search (RAG)</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">15 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Index documents with embeddings</li>
          <li>Retrieve relevant context for queries</li>
          <li>Build RAG-powered agents</li>
          <li>Hybrid search with metadata filters</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Agent, SemanticMemory } from '@cogitator-ai/core';
import { VectorStore } from '@cogitator-ai/memory';

// Create vector store for embeddings
const vectorStore = new VectorStore({
  type: 'hnswlib',              // Or 'pinecone', 'qdrant', 'chroma'
  dimensions: 1536,              // Embedding dimensions
  path: './embeddings',
});

const memory = new SemanticMemory({
  vectorStore,
  embeddingModel: 'ollama/nomic-embed-text',
  chunkSize: 500,               // Chunk documents into 500 char pieces
  chunkOverlap: 50,             // 50 char overlap between chunks
});

// Index documents
await memory.index([
  { id: 'doc1', content: 'Cogitator is a self-hosted AI agent runtime...', metadata: { type: 'docs' } },
  { id: 'doc2', content: 'Agents can use tools to interact with...', metadata: { type: 'docs' } },
  { id: 'doc3', content: 'Workflows orchestrate multiple agents...', metadata: { type: 'tutorial' } },
]);

// Create RAG-enabled agent
const agent = new Agent({
  name: 'docs-assistant',
  model: 'ollama/llama3.2',
  memory,
  instructions: \`Answer questions using the provided context.
If you don't find the answer in context, say so.\`,
});

// Agent automatically retrieves relevant context
const response = await agent.run({
  input: 'How do workflows work in Cogitator?',
});

console.log('Answer:', response.output);
console.log('Sources used:', response.context.sources);
// ['doc3', 'doc2']`}</CodeBlock>

        <Callout type="info">
          Semantic search finds contextually relevant information even when exact keywords
          don&apos;t match. Perfect for documentation, knowledge bases, and support systems.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Hybrid Search with Filters</h3>
        <CodeBlock>{`// Search with metadata filters
const results = await memory.search({
  query: 'agent tools',
  topK: 5,
  filter: {
    type: 'docs',           // Only search documentation
    version: { $gte: '2.0' }, // Version 2.0+
  },
  minScore: 0.7,             // Minimum similarity threshold
});

console.log('Results:', results);

// Hybrid search: semantic + keyword
const hybridResults = await memory.hybridSearch({
  query: 'how to create custom tools',
  semantic: { weight: 0.7 },  // 70% semantic
  keyword: { weight: 0.3 },   // 30% keyword (BM25)
  topK: 10,
});

// Update document without re-indexing everything
await memory.update('doc1', {
  content: 'Updated content...',
  metadata: { type: 'docs', version: '2.1' },
});

// Delete documents
await memory.delete(['doc1', 'doc2']);

// Batch operations for large datasets
await memory.batchIndex(documents, {
  batchSize: 100,
  onProgress: (indexed, total) => {
    console.log(\`Indexed \${indexed}/\${total}\`);
  },
});`}</CodeBlock>
      </>
    ),

    'long-term-memory': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Long-term Memory</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">15 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Store facts and knowledge persistently</li>
          <li>Build agent memory that spans sessions</li>
          <li>Implement memory consolidation</li>
          <li>Query historical interactions</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Agent, LongTermMemory } from '@cogitator-ai/core';
import { MemoryStore, VectorStore } from '@cogitator-ai/memory';

const longTermMemory = new LongTermMemory({
  store: new MemoryStore({ type: 'sqlite', path: './ltm.db' }),
  vectorStore: new VectorStore({ type: 'hnswlib', path: './ltm-vectors' }),
  embeddingModel: 'ollama/nomic-embed-text',

  // Memory consolidation settings
  consolidation: {
    enabled: true,
    schedule: 'daily',         // Consolidate memories daily
    strategy: 'importance',    // Keep important memories longer
    maxAge: '90d',             // Forget after 90 days of no access
  },
});

const agent = new Agent({
  name: 'personal-assistant',
  model: 'ollama/llama3.2',
  memory: longTermMemory,
  instructions: 'You remember everything about the user to provide personalized assistance.',
});

// Agent learns facts from conversations
await agent.run({ input: 'I have a meeting with John every Monday at 2pm.' });
await agent.run({ input: 'My favorite coffee is a flat white with oat milk.' });

// Later (even in a new session)
const response = await agent.run({
  input: 'What should I order at the coffee shop?',
});
console.log(response.output);
// "Based on your preferences, I'd suggest a flat white with oat milk!"

// Query stored memories directly
const memories = await longTermMemory.query({
  text: 'meeting schedule',
  timeRange: { start: '2024-01-01', end: '2024-12-31' },
  limit: 10,
});

console.log('Relevant memories:', memories);`}</CodeBlock>

        <Callout type="tip">
          Long-term memory enables truly personalized agents that learn and remember user
          preferences, facts, and context across unlimited sessions.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Memory Types & Importance</h3>
        <CodeBlock>{`// Store different types of memories with importance scores
await longTermMemory.store({
  type: 'fact',
  content: 'User prefers dark mode',
  importance: 0.8,
  tags: ['preferences', 'ui'],
});

await longTermMemory.store({
  type: 'event',
  content: 'User completed project Alpha',
  importance: 0.9,
  timestamp: new Date(),
  tags: ['work', 'achievement'],
});

await longTermMemory.store({
  type: 'relationship',
  content: 'John is the user\\'s manager',
  importance: 0.95,
  entities: ['John', 'user'],
  tags: ['people', 'work'],
});

// Query by type
const facts = await longTermMemory.getByType('fact');
const events = await longTermMemory.getByType('event', {
  since: '2024-01-01',
  minImportance: 0.7,
});

// Memory reflection - agent summarizes what it knows
const reflection = await longTermMemory.reflect({
  topic: 'user work habits',
  depth: 'detailed',
});

console.log('Reflection:', reflection);
// "The user has regular Monday meetings with John, their manager.
//  They recently completed project Alpha. They prefer working..."

// Export/import for backup
const backup = await longTermMemory.export();
await longTermMemory.import(backup);`}</CodeBlock>
      </>
    ),

    sandbox: (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">Sandbox Execution</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Execute agent-generated code safely in isolated Docker or WASM environments.
        </p>
      </>
    ),

    'docker-execution': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Docker Execution</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">15 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Run agent-generated code in Docker containers</li>
          <li>Configure resource limits and timeouts</li>
          <li>Install packages dynamically</li>
          <li>Handle file I/O securely</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { DockerSandbox } from '@cogitator-ai/sandbox';
import { Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

// Create Docker sandbox for Python execution
const sandbox = new DockerSandbox({
  image: 'python:3.11-slim',
  timeout: 30000,          // 30 second timeout
  memoryLimit: '512m',     // 512MB RAM limit
  cpuLimit: 1,             // 1 CPU core
  networkAccess: false,    // No network by default
});

// Create a code execution tool
const runPython = tool({
  name: 'run_python',
  description: 'Execute Python code safely in a sandbox',
  schema: z.object({
    code: z.string().describe('Python code to execute'),
    packages: z.array(z.string()).optional().describe('Packages to install'),
  }),
  execute: async ({ code, packages }) => {
    // Install packages if needed
    if (packages?.length) {
      await sandbox.exec(\`pip install \${packages.join(' ')}\`);
    }

    // Execute the code
    const result = await sandbox.exec(\`python -c "\${code.replace(/"/g, '\\\\"')}"\`);

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  },
});

const agent = new Agent({
  name: 'code-runner',
  model: 'ollama/llama3.2',
  tools: [runPython],
  instructions: 'You can run Python code to analyze data and solve problems.',
});

const result = await agent.run({
  input: 'Calculate the first 20 Fibonacci numbers',
});

console.log(result.output);
// The agent generates and executes Python code safely`}</CodeBlock>

        <Callout type="warning">
          Always use sandboxes for agent-generated code. Never execute untrusted code directly on
          your host machine.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">File I/O & Persistence</h3>
        <CodeBlock>{`const sandbox = new DockerSandbox({
  image: 'python:3.11-slim',
  volumes: {
    './data': '/app/data',     // Mount local data directory
    './output': '/app/output', // Mount output directory
  },
  workdir: '/app',
});

// Write files to sandbox
await sandbox.writeFile('/app/input.csv', csvData);

// Execute code that reads/writes files
await sandbox.exec(\`
python << 'EOF'
import pandas as pd
df = pd.read_csv('/app/input.csv')
summary = df.describe()
summary.to_csv('/app/output/summary.csv')
print(f"Processed {len(df)} rows")
EOF
\`);

// Read output files
const summary = await sandbox.readFile('/app/output/summary.csv');
console.log('Summary:', summary);

// Cleanup
await sandbox.cleanup();

// Pool of sandboxes for concurrent execution
const pool = new DockerSandbox.Pool({
  image: 'node:20-slim',
  size: 5,              // 5 containers
  recycleAfter: 10,     // Recycle after 10 executions
});

const results = await Promise.all(
  tasks.map(task => pool.exec(task.code))
);

await pool.shutdown();`}</CodeBlock>
      </>
    ),

    'wasm-execution': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">WASM Execution</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">10 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Run code with millisecond startup times</li>
          <li>Use WASM for lightweight sandboxing</li>
          <li>Execute JavaScript, Python, and more</li>
          <li>Perfect for high-frequency executions</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { WasmSandbox } from '@cogitator-ai/sandbox';
import { Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

// Create WASM sandbox (much faster than Docker)
const sandbox = new WasmSandbox({
  runtime: 'quickjs',      // JavaScript runtime
  timeout: 5000,           // 5 second timeout
  memoryLimit: 64,         // 64MB
});

// Create a JavaScript execution tool
const runJS = tool({
  name: 'run_js',
  description: 'Execute JavaScript code',
  schema: z.object({
    code: z.string().describe('JavaScript code to execute'),
  }),
  execute: async ({ code }) => {
    const result = await sandbox.run(code);
    return result;
  },
});

const agent = new Agent({
  name: 'js-runner',
  model: 'ollama/llama3.2',
  tools: [runJS],
  instructions: 'You can run JavaScript code for calculations and data processing.',
});

// WASM execution is fast - perfect for many small executions
const startTime = Date.now();
const result = await agent.run({
  input: 'Calculate 50! (factorial)',
});
console.log(\`Executed in \${Date.now() - startTime}ms\`);
// Typically < 100ms including LLM call`}</CodeBlock>

        <Callout type="tip">
          WASM sandboxes start in milliseconds vs seconds for Docker. Use them for frequent, small
          code executions where speed matters.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Python via WASM</h3>
        <CodeBlock>{`import { WasmSandbox } from '@cogitator-ai/sandbox';

// Python in WASM using Pyodide
const pythonSandbox = new WasmSandbox({
  runtime: 'pyodide',
  timeout: 10000,
  preload: ['numpy', 'pandas'],  // Pre-load common packages
});

await pythonSandbox.init();  // Initialize once, reuse many times

// Fast execution after initialization
const result = await pythonSandbox.run(\`
import numpy as np
import pandas as pd

data = np.random.randn(1000, 4)
df = pd.DataFrame(data, columns=['A', 'B', 'C', 'D'])
print(df.describe().to_json())
\`);

console.log('Stats:', JSON.parse(result.stdout));

// Sandbox pool for concurrent WASM execution
const pool = new WasmSandbox.Pool({
  runtime: 'quickjs',
  size: 10,
  timeout: 3000,
});

// Process many items in parallel
const items = Array.from({ length: 100 }, (_, i) => i);
const results = await Promise.all(
  items.map(i => pool.run(\`
    const result = Array.from({length: 1000}, () => Math.random())
      .reduce((a, b) => a + b) / 1000;
    result;
  \`))
);

console.log('Processed', results.length, 'items');
await pool.shutdown();`}</CodeBlock>
      </>
    ),

    mcp: (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">MCP Integration</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Connect to Model Context Protocol servers and expose your tools as MCP endpoints.
        </p>
      </>
    ),

    'connect-mcp': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Connect to MCP Servers</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">15 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Connect agents to MCP tool servers</li>
          <li>Use external tools via MCP protocol</li>
          <li>Access file systems, databases, and APIs</li>
          <li>Combine multiple MCP servers</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { MCPClient } from '@cogitator-ai/mcp';
import { Agent } from '@cogitator-ai/core';

// Connect to an MCP server (filesystem example)
const mcpClient = new MCPClient({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', './'],
});

await mcpClient.connect();

// List available tools from the server
const tools = await mcpClient.listTools();
console.log('Available MCP tools:', tools);
// ['read_file', 'write_file', 'list_directory', ...]

// Create agent with MCP tools
const agent = new Agent({
  name: 'file-assistant',
  model: 'ollama/llama3.2',
  tools: mcpClient.getTools(),  // Use MCP tools directly
  instructions: 'You help manage files and directories.',
});

const result = await agent.run({
  input: 'List all TypeScript files in the src directory',
});

console.log(result.output);
// Agent uses MCP read_file and list_directory tools

// Cleanup
await mcpClient.disconnect();`}</CodeBlock>

        <Callout type="info">
          MCP (Model Context Protocol) is an open standard for connecting AI models to external
          tools and data sources. Any MCP-compatible server works with Cogitator.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Multiple MCP Servers</h3>
        <CodeBlock>{`import { MCPClient, MCPHub } from '@cogitator-ai/mcp';

// Create a hub to manage multiple MCP connections
const hub = new MCPHub();

// Add filesystem server
await hub.addServer('filesystem', {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', './'],
});

// Add GitHub server
await hub.addServer('github', {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
});

// Add PostgreSQL server
await hub.addServer('postgres', {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-postgres'],
  env: { DATABASE_URL: process.env.DATABASE_URL },
});

// Get all tools from all servers
const allTools = hub.getAllTools();
console.log('Total tools:', allTools.length);

// Create agent with tools from all servers
const agent = new Agent({
  name: 'multi-tool-agent',
  model: 'ollama/llama3.2',
  tools: allTools,
  instructions: \`You can:
- Read and write files
- Interact with GitHub repositories
- Query PostgreSQL databases\`,
});

// Agent can use tools from any connected server
const result = await agent.run({
  input: 'Read the README.md, then create a GitHub issue summarizing it',
});

// Graceful shutdown
await hub.disconnectAll();`}</CodeBlock>
      </>
    ),

    'create-mcp': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Create MCP Server</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="advanced" />
          <span className="text-[#666] text-sm">20 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Create your own MCP tool server</li>
          <li>Expose Cogitator tools via MCP</li>
          <li>Handle MCP protocol messages</li>
          <li>Deploy MCP servers for others to use</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { MCPServer } from '@cogitator-ai/mcp';
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

// Create custom tools
const calculateTool = tool({
  name: 'calculate',
  description: 'Perform mathematical calculations',
  schema: z.object({
    expression: z.string().describe('Math expression to evaluate'),
  }),
  execute: async ({ expression }) => {
    const result = Function(\`"use strict"; return (\${expression})\`)();
    return { result };
  },
});

const weatherTool = tool({
  name: 'get_weather',
  description: 'Get current weather for a location',
  schema: z.object({
    location: z.string().describe('City name'),
  }),
  execute: async ({ location }) => {
    const response = await fetch(
      \`https://api.weather.example/v1/current?city=\${location}\`
    );
    return response.json();
  },
});

// Create MCP server with these tools
const server = new MCPServer({
  name: 'my-tools',
  version: '1.0.0',
  tools: [calculateTool, weatherTool],
});

// Start the server (stdio transport for CLI usage)
server.start({ transport: 'stdio' });

console.error('MCP server running...');
// Now other MCP clients can connect and use these tools`}</CodeBlock>

        <Callout type="tip">
          Creating an MCP server lets you share your tools with any MCP-compatible client - Claude
          Desktop, other agents, or your own applications.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">HTTP Transport & Resources</h3>
        <CodeBlock>{`import { MCPServer } from '@cogitator-ai/mcp';

const server = new MCPServer({
  name: 'api-bridge',
  version: '1.0.0',
  tools: [...yourTools],

  // Expose resources (read-only data)
  resources: [
    {
      uri: 'config://app-settings',
      name: 'App Settings',
      mimeType: 'application/json',
      read: async () => {
        return JSON.stringify(await loadConfig());
      },
    },
    {
      uri: 'docs://api-reference',
      name: 'API Reference',
      mimeType: 'text/markdown',
      read: async () => {
        return await fs.readFile('./docs/api.md', 'utf-8');
      },
    },
  ],

  // Expose prompts (reusable templates)
  prompts: [
    {
      name: 'analyze-code',
      description: 'Analyze code for issues',
      arguments: [
        { name: 'code', description: 'Code to analyze', required: true },
        { name: 'language', description: 'Programming language' },
      ],
      template: ({ code, language }) => \`
        Analyze this \${language || 'code'} for potential issues:
        \\\`\\\`\\\`
        \${code}
        \\\`\\\`\\\`
      \`,
    },
  ],
});

// Start with HTTP transport (for remote access)
await server.start({
  transport: 'http',
  port: 3001,
  auth: {
    type: 'bearer',
    validate: async (token) => {
      return token === process.env.MCP_API_KEY;
    },
  },
});

console.log('MCP server running at http://localhost:3001');

// Clients can now connect via HTTP
// const client = new MCPClient({
//   transport: 'http',
//   url: 'http://localhost:3001',
//   headers: { Authorization: 'Bearer <token>' },
// });`}</CodeBlock>
      </>
    ),

    production: (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">Production</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Production-ready patterns: cost optimization, budget enforcement, tracing, and error
          handling.
        </p>
      </>
    ),

    'cost-routing': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Cost-Aware Routing</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">15 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Route tasks to the most cost-effective model</li>
          <li>Balance quality vs cost automatically</li>
          <li>Set up model fallback chains</li>
          <li>Track and report on spending</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Cogitator, Agent, CostRouter } from '@cogitator-ai/core';

const cog = new Cogitator();

// Define model tiers with costs
const router = new CostRouter({
  models: {
    cheap: {
      model: 'ollama/llama3.2',
      costPer1kTokens: 0,        // Local, free
      maxTokens: 4096,
      qualityScore: 0.7,
    },
    standard: {
      model: 'openai/gpt-4o-mini',
      costPer1kTokens: 0.00015,
      maxTokens: 128000,
      qualityScore: 0.85,
    },
    premium: {
      model: 'anthropic/claude-3-5-sonnet',
      costPer1kTokens: 0.003,
      maxTokens: 200000,
      qualityScore: 0.95,
    },
  },

  // Routing strategy
  strategy: 'quality-threshold',
  config: {
    defaultQuality: 0.8,         // Use cheapest model meeting 80% quality
    complexityThreshold: 0.6,    // Route complex tasks to better models
    retryOnFailure: true,        // Try better model if cheap one fails
  },
});

const agent = new Agent({
  name: 'cost-optimized',
  router,  // Use router instead of fixed model
  instructions: 'You complete tasks efficiently.',
});

// Simple task → routed to cheap model
const simple = await agent.run({
  input: 'What is 2 + 2?',
});
console.log('Used:', simple.modelUsed);  // ollama/llama3.2
console.log('Cost:', simple.cost);        // $0.00

// Complex task → routed to premium model
const complex = await agent.run({
  input: 'Design a microservices architecture for a banking system',
  quality: 0.95,  // Request high quality
});
console.log('Used:', complex.modelUsed);  // anthropic/claude-3-5-sonnet
console.log('Cost:', complex.cost);        // $0.05`}</CodeBlock>

        <Callout type="tip">
          Cost-aware routing can reduce LLM costs by 60-80% by using cheaper models for simple tasks
          while maintaining quality for complex ones.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Usage Reports</h3>
        <CodeBlock>{`// Get cost report
const report = router.getReport({
  period: 'last-7d',
  groupBy: 'model',
});

console.log('Cost breakdown:', report);
// {
//   'ollama/llama3.2': { requests: 1250, tokens: 500000, cost: 0 },
//   'openai/gpt-4o-mini': { requests: 300, tokens: 150000, cost: 22.50 },
//   'anthropic/claude-3-5-sonnet': { requests: 50, tokens: 100000, cost: 300 },
//   total: { requests: 1600, tokens: 750000, cost: 322.50 }
// }

// Set alerts
router.on('cost-threshold', (event) => {
  if (event.dailyCost > 100) {
    console.warn('Daily cost exceeds $100!');
    notifySlack('High LLM spending alert');
  }
});

// Dynamic routing based on load
router.setRoutingRule((task, context) => {
  // During peak hours, prefer local models
  const hour = new Date().getHours();
  if (hour >= 9 && hour <= 17) {
    return { preferLocal: true, maxCost: 0.001 };
  }
  return { preferLocal: false };
});`}</CodeBlock>
      </>
    ),

    'budget-enforcement': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Budget Enforcement</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="easy" />
          <span className="text-[#666] text-sm">10 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Set spending limits per agent/user/project</li>
          <li>Get warnings before hitting limits</li>
          <li>Handle budget exhaustion gracefully</li>
          <li>Reset budgets on schedule</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Cogitator, Agent, BudgetManager } from '@cogitator-ai/core';

const cog = new Cogitator();

// Create budget manager
const budget = new BudgetManager({
  limits: {
    daily: 50,       // $50/day
    monthly: 1000,   // $1000/month
    perRequest: 1,   // Max $1 per request
  },

  // What to do when budget exhausted
  onExhausted: 'queue',  // 'reject' | 'queue' | 'fallback'

  // Warning thresholds
  warnings: {
    75: (remaining) => console.warn(\`75% budget used. \$\${remaining} left\`),
    90: (remaining) => notifyTeam(\`90% budget used!\`),
  },
});

const agent = new Agent({
  name: 'budget-conscious',
  model: 'openai/gpt-4o',
  budget,  // Attach budget manager
  instructions: 'You are a helpful assistant.',
});

try {
  const result = await agent.run({
    input: 'Help me with this task',
  });
  console.log('Cost:', result.cost);
  console.log('Budget remaining:', budget.getRemaining());
} catch (error) {
  if (error.code === 'BUDGET_EXHAUSTED') {
    console.log('Budget exhausted, try again tomorrow');
    console.log('Resets at:', error.resetsAt);
  }
}`}</CodeBlock>

        <Callout type="warning">
          Always set budget limits in production to prevent runaway costs from bugs or abuse.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Per-User Budgets</h3>
        <CodeBlock>{`// Budget per user or tenant
const userBudgets = new BudgetManager({
  scope: 'per-user',
  limits: {
    daily: 5,     // $5/day per user
    monthly: 100, // $100/month per user
  },
  storage: 'redis',  // Persist budgets in Redis
  redisUrl: process.env.REDIS_URL,
});

// Track by user ID
const result = await agent.run({
  input: 'User request...',
  userId: 'user-123',  // Budget tracked per user
});

// Check user's budget
const userBudget = await userBudgets.getStatus('user-123');
console.log('User budget:', userBudget);
// { daily: { used: 2.50, limit: 5, remaining: 2.50 },
//   monthly: { used: 45, limit: 100, remaining: 55 } }

// Admin can adjust limits
await userBudgets.setLimit('user-123', {
  daily: 10,     // Increase daily limit
  monthly: 200,  // Increase monthly limit
});

// Get all users' usage
const allUsage = await userBudgets.getAllUsage({
  period: 'current-month',
  sortBy: 'cost',
  limit: 10,
});

console.log('Top spenders:', allUsage);`}</CodeBlock>
      </>
    ),

    'otel-tracing': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">OpenTelemetry Tracing</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">15 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Add observability to agent execution</li>
          <li>Trace LLM calls, tool executions, and workflows</li>
          <li>Export traces to any OpenTelemetry backend</li>
          <li>Debug performance issues</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Cogitator, Agent } from '@cogitator-ai/core';
import { OTelTracer } from '@cogitator-ai/telemetry';
import { trace } from '@opentelemetry/api';

// Set up OpenTelemetry
const tracer = new OTelTracer({
  serviceName: 'cogitator-agent',
  exporter: 'otlp',  // or 'jaeger', 'zipkin', 'console'
  endpoint: 'http://localhost:4318',

  // What to trace
  traceOptions: {
    llmCalls: true,       // Trace every LLM request
    toolExecutions: true, // Trace tool calls
    workflows: true,      // Trace workflow steps
    embeddings: true,     // Trace embedding generations
  },

  // Add custom attributes
  attributes: {
    environment: process.env.NODE_ENV,
    version: '1.0.0',
  },
});

const cog = new Cogitator({
  telemetry: tracer,
});

const agent = new Agent({
  name: 'traced-agent',
  model: 'ollama/llama3.2',
  instructions: 'You are a helpful assistant.',
});

// All operations are automatically traced
const result = await agent.run({
  input: 'Search for recent news about AI',
});

// Traces show:
// - Agent.run (parent span)
//   - LLM.complete (child span with model, tokens, latency)
//   - Tool.execute: web_search (child span with params, result)
//   - LLM.complete (second call to process results)

console.log('Trace ID:', result.traceId);
// View in Jaeger: http://localhost:16686/trace/{traceId}`}</CodeBlock>

        <Callout type="info">
          OpenTelemetry traces help you understand exactly what your agents are doing and where time
          is spent.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Custom Spans & Metrics</h3>
        <CodeBlock>{`import { trace, metrics } from '@opentelemetry/api';

const tracer = trace.getTracer('my-app');
const meter = metrics.getMeter('my-app');

// Custom metrics
const requestCounter = meter.createCounter('agent.requests');
const latencyHistogram = meter.createHistogram('agent.latency');
const tokenGauge = meter.createObservableGauge('agent.tokens_used');

// Add custom spans around business logic
async function processCustomerRequest(request) {
  return tracer.startActiveSpan('process-customer-request', async (span) => {
    span.setAttribute('customer.id', request.customerId);
    span.setAttribute('request.type', request.type);

    try {
      const result = await agent.run({
        input: request.message,
        context: { customerId: request.customerId },
      });

      span.setAttribute('response.length', result.output.length);
      span.setAttribute('tokens.used', result.tokensUsed);
      span.setStatus({ code: SpanStatusCode.OK });

      requestCounter.add(1, { status: 'success', type: request.type });
      latencyHistogram.record(result.latency);

      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.recordException(error);
      requestCounter.add(1, { status: 'error', type: request.type });
      throw error;
    } finally {
      span.end();
    }
  });
}

// Export traces to multiple backends
const tracer = new OTelTracer({
  exporters: [
    { type: 'otlp', endpoint: 'http://tempo:4318' },
    { type: 'console' },  // Also log to console
  ],
});`}</CodeBlock>
      </>
    ),

    'error-handling': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-2">Error Handling & Fallbacks</h2>
        <div className="flex items-center gap-3 mb-6">
          <DifficultyBadge level="medium" />
          <span className="text-[#666] text-sm">15 min</span>
        </div>

        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">What You&apos;ll Learn</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-1 mb-6">
          <li>Handle LLM API errors gracefully</li>
          <li>Implement retry strategies</li>
          <li>Set up fallback models</li>
          <li>Use circuit breakers for resilience</li>
        </ul>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">The Code</h3>
        <CodeBlock>{`import { Agent, ErrorHandler, RetryPolicy, CircuitBreaker } from '@cogitator-ai/core';

// Configure retry policy
const retryPolicy = new RetryPolicy({
  maxRetries: 3,
  backoff: 'exponential',  // or 'linear', 'constant'
  initialDelay: 1000,      // 1 second
  maxDelay: 30000,         // Max 30 seconds
  retryOn: [
    'RATE_LIMIT',          // Retry on rate limits
    'TIMEOUT',             // Retry on timeouts
    'SERVER_ERROR',        // Retry on 5xx errors
  ],
});

// Configure fallback chain
const fallbackChain = [
  'openai/gpt-4o',           // Primary
  'anthropic/claude-3-5-sonnet', // Fallback 1
  'ollama/llama3.2',         // Fallback 2 (local)
];

const agent = new Agent({
  name: 'resilient-agent',
  model: fallbackChain[0],
  fallbackModels: fallbackChain.slice(1),
  retryPolicy,
  instructions: 'You are a helpful assistant.',
});

// Agent automatically retries and falls back
const result = await agent.run({
  input: 'Process this request',
});

console.log('Final model used:', result.modelUsed);
console.log('Retries attempted:', result.retries);
console.log('Fallbacks used:', result.fallbacksUsed);`}</CodeBlock>

        <Callout type="warning">
          Always implement error handling in production. LLM APIs can fail, rate limit, or timeout
          unexpectedly.
        </Callout>

        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Circuit Breaker Pattern</h3>
        <CodeBlock>{`import { CircuitBreaker } from '@cogitator-ai/core';

// Circuit breaker prevents cascading failures
const circuitBreaker = new CircuitBreaker({
  failureThreshold: 5,     // Open after 5 failures
  successThreshold: 2,     // Close after 2 successes
  timeout: 30000,          // Request timeout
  resetTimeout: 60000,     // Try again after 1 minute

  // Per-model circuit breakers
  perModel: true,

  // Custom failure detection
  isFailure: (error) => {
    return error.code !== 'CONTENT_FILTERED';  // Don't count content filters
  },
});

const agent = new Agent({
  name: 'circuit-protected',
  model: 'openai/gpt-4o',
  circuitBreaker,
  fallbackModels: ['ollama/llama3.2'],
  instructions: 'You complete tasks reliably.',
});

// Monitor circuit state
circuitBreaker.on('open', (model) => {
  console.warn(\`Circuit opened for \${model}\`);
  alertOps(\`Model \${model} circuit breaker opened\`);
});

circuitBreaker.on('half-open', (model) => {
  console.log(\`Testing \${model} availability...\`);
});

circuitBreaker.on('close', (model) => {
  console.log(\`\${model} recovered, circuit closed\`);
});

// Error handler with custom recovery
const errorHandler = new ErrorHandler({
  handlers: {
    RATE_LIMIT: async (error, context) => {
      const retryAfter = error.retryAfter || 60;
      console.log(\`Rate limited, waiting \${retryAfter}s...\`);
      await sleep(retryAfter * 1000);
      return { retry: true };
    },

    CONTEXT_LENGTH_EXCEEDED: async (error, context) => {
      console.log('Context too long, truncating...');
      return {
        retry: true,
        modifiedInput: truncateContext(context.input, 0.5),
      };
    },

    CONTENT_FILTERED: async (error, context) => {
      console.warn('Content filtered:', error.message);
      return {
        retry: false,
        fallbackResponse: 'I cannot process this request.',
      };
    },
  },
});

const result = await agent.run({
  input: 'Process this...',
  errorHandler,
});`}</CodeBlock>
      </>
    ),
  };

  return (
    <div className="prose prose-invert max-w-none">
      {content[recipeId] || content['getting-started']}
    </div>
  );
}

export default function CookbookPage() {
  const [activeRecipe, setActiveRecipe] = useState('getting-started');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash) setActiveRecipe(hash);
  }, []);

  const handleRecipeClick = (id: string) => {
    setActiveRecipe(id);
    setMobileMenuOpen(false);
    window.history.pushState(null, '', `#${id}`);
  };

  const filteredSections = sections
    .map((section) => ({
      ...section,
      recipes: section.recipes.filter((r) =>
        r.title.toLowerCase().includes(searchQuery.toLowerCase())
      ),
    }))
    .filter(
      (s) => s.recipes.length > 0 || s.title.toLowerCase().includes(searchQuery.toLowerCase())
    );

  const totalRecipes = sections.reduce((acc, s) => acc + s.recipes.length, 0);

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <header className="fixed top-0 left-0 right-0 z-50 bg-[#0a0a0a]/80 backdrop-blur-xl border-b border-[#1a1a1a]">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-2">
              <div className="w-8 h-8 bg-gradient-to-br from-[#00ff88] to-[#00aa55] rounded-lg flex items-center justify-center">
                <span className="text-[#0a0a0a] font-bold text-lg">C</span>
              </div>
              <span className="text-[#fafafa] font-bold text-xl hidden sm:block">Cogitator</span>
            </Link>
            <span className="text-[#333] hidden sm:block">/</span>
            <span className="text-[#00ff88] font-mono text-sm hidden sm:block">cookbook</span>
            <span className="text-[#444] text-xs hidden md:block">({totalRecipes} recipes)</span>
          </div>

          <div className="flex items-center gap-4">
            <div className="relative hidden md:block">
              <input
                type="text"
                placeholder="Search recipes..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-64 px-4 py-2 bg-[#111] border border-[#222] rounded-lg text-[#fafafa] text-sm placeholder-[#666] focus:outline-none focus:border-[#00ff88]"
              />
              <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[#444] text-xs">
                ⌘K
              </kbd>
            </div>
            <Link
              href="/docs"
              className="px-3 py-2 text-[#a1a1a1] hover:text-[#fafafa] text-sm transition-colors"
            >
              Docs
            </Link>
            <Link
              href="/dashboard"
              className="px-4 py-2 bg-[#00ff88] text-[#0a0a0a] font-semibold rounded-lg text-sm hover:bg-[#00cc6a] transition-colors"
            >
              Dashboard
            </Link>
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden p-2 text-[#fafafa]"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 6h16M4 12h16M4 18h16"
                />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, x: -300 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -300 }}
            className="fixed inset-0 z-40 md:hidden"
          >
            <div
              className="absolute inset-0 bg-black/50"
              onClick={() => setMobileMenuOpen(false)}
            />
            <div className="absolute left-0 top-0 bottom-0 w-72 bg-[#0a0a0a] border-r border-[#1a1a1a] pt-20 p-4 overflow-auto">
              {sections.map((section) => (
                <div key={section.id} className="mb-4">
                  <button
                    onClick={() => handleRecipeClick(section.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg flex items-center gap-2 ${
                      activeRecipe === section.id
                        ? 'bg-[#00ff88]/10 text-[#00ff88]'
                        : 'text-[#a1a1a1] hover:text-[#fafafa]'
                    }`}
                  >
                    <span>{section.icon}</span>
                    <span>{section.title}</span>
                  </button>
                  {section.recipes.map((recipe) => (
                    <button
                      key={recipe.id}
                      onClick={() => handleRecipeClick(recipe.id)}
                      className={`w-full text-left pl-10 pr-3 py-1 text-sm ${
                        activeRecipe === recipe.id
                          ? 'text-[#00ff88]'
                          : 'text-[#666] hover:text-[#a1a1a1]'
                      }`}
                    >
                      {recipe.title}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex pt-16">
        <aside className="hidden md:block w-72 fixed left-0 top-16 bottom-0 border-r border-[#1a1a1a] overflow-auto p-4">
          <nav className="space-y-1">
            {filteredSections.map((section) => (
              <div key={section.id}>
                <button
                  onClick={() => handleRecipeClick(section.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg flex items-center gap-2 transition-colors ${
                    activeRecipe === section.id ||
                    section.recipes.some((r) => r.id === activeRecipe)
                      ? 'bg-[#00ff88]/10 text-[#00ff88]'
                      : 'text-[#a1a1a1] hover:text-[#fafafa] hover:bg-[#111]'
                  }`}
                >
                  <span>{section.icon}</span>
                  <span className="font-medium">{section.title}</span>
                  <span className="ml-auto text-xs text-[#444]">{section.recipes.length}</span>
                </button>
                <div className="ml-4 mt-1 space-y-0.5">
                  {section.recipes.map((recipe) => (
                    <button
                      key={recipe.id}
                      onClick={() => handleRecipeClick(recipe.id)}
                      className={`w-full text-left pl-6 pr-3 py-1.5 rounded text-sm transition-colors flex items-center gap-2 ${
                        activeRecipe === recipe.id
                          ? 'text-[#00ff88] bg-[#00ff88]/5'
                          : 'text-[#666] hover:text-[#a1a1a1]'
                      }`}
                    >
                      <span className="flex-1">{recipe.title}</span>
                      <span className="text-[#444] text-xs">{recipe.time}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        <main className="flex-1 md:ml-72 min-h-screen">
          <div className="max-w-4xl mx-auto px-6 py-12">
            <motion.div
              key={activeRecipe}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
            >
              <RecipeContent recipeId={activeRecipe} />
            </motion.div>

            <div className="mt-16 pt-8 border-t border-[#1a1a1a] flex items-center justify-between text-sm">
              <div className="text-[#666]">
                <a
                  href="https://github.com/eL1fe/cogitator/tree/main/examples"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#00ff88] hover:underline"
                >
                  View all examples on GitHub →
                </a>
              </div>
              <div className="flex items-center gap-4">
                <a
                  href="https://discord.gg/SkmRsYvA"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#5865F2] hover:text-[#7289DA] flex items-center gap-1"
                >
                  Discord
                </a>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
