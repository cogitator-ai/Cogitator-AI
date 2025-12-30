'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';

interface Section {
  id: string;
  title: string;
  icon: string;
  subsections?: { id: string; title: string }[];
}

const sections: Section[] = [
  {
    id: 'getting-started',
    title: 'Getting Started',
    icon: '🚀',
    subsections: [
      { id: 'installation', title: 'Installation' },
      { id: 'quickstart', title: 'Quick Start' },
      { id: 'configuration', title: 'Configuration' },
    ],
  },
  {
    id: 'agents',
    title: 'Agents',
    icon: '🤖',
    subsections: [
      { id: 'agent-basics', title: 'Agent Basics' },
      { id: 'agent-tools', title: 'Tools & Functions' },
      { id: 'agent-memory', title: 'Agent Memory' },
    ],
  },
  {
    id: 'workflows',
    title: 'Workflows',
    icon: '📊',
    subsections: [
      { id: 'workflow-basics', title: 'Workflow Basics' },
      { id: 'workflow-nodes', title: 'Node Types' },
      { id: 'workflow-conditions', title: 'Conditions & Branching' },
    ],
  },
  {
    id: 'swarms',
    title: 'Swarms',
    icon: '🐝',
    subsections: [
      { id: 'swarm-basics', title: 'Swarm Basics' },
      { id: 'swarm-patterns', title: 'Coordination Patterns' },
      { id: 'swarm-consensus', title: 'Consensus Mechanisms' },
    ],
  },
  {
    id: 'models',
    title: 'Models',
    icon: '🧠',
    subsections: [
      { id: 'model-providers', title: 'Model Providers' },
      { id: 'model-ollama', title: 'Ollama Integration' },
      { id: 'model-pricing', title: 'Pricing & Limits' },
    ],
  },
  {
    id: 'memory',
    title: 'Memory & RAG',
    icon: '💾',
    subsections: [
      { id: 'memory-types', title: 'Memory Types' },
      { id: 'memory-rag', title: 'RAG Pipeline' },
      { id: 'memory-vectors', title: 'Vector Storage' },
    ],
  },
  {
    id: 'sandbox',
    title: 'Code Sandbox',
    icon: '📦',
    subsections: [
      { id: 'sandbox-docker', title: 'Docker Executor' },
      { id: 'sandbox-wasm', title: 'WASM Executor' },
      { id: 'sandbox-security', title: 'Security Model' },
    ],
  },
  {
    id: 'mcp',
    title: 'MCP Protocol',
    icon: '🔌',
    subsections: [
      { id: 'mcp-overview', title: 'Protocol Overview' },
      { id: 'mcp-servers', title: 'MCP Servers' },
      { id: 'mcp-tools', title: 'Tool Registration' },
    ],
  },
  {
    id: 'api',
    title: 'API Reference',
    icon: '📡',
    subsections: [
      { id: 'api-rest', title: 'REST API' },
      { id: 'api-openai', title: 'OpenAI Compatible' },
      { id: 'api-websocket', title: 'WebSocket Events' },
    ],
  },
  {
    id: 'observability',
    title: 'Observability',
    icon: '📈',
    subsections: [
      { id: 'obs-tracing', title: 'Distributed Tracing' },
      { id: 'obs-metrics', title: 'Metrics & Prometheus' },
      { id: 'obs-logging', title: 'Structured Logging' },
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

function Callout({ type, children }: { type: 'info' | 'warning' | 'tip'; children: React.ReactNode }) {
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

function DocsContent({ activeSection }: { activeSection: string }) {
  const content: Record<string, React.ReactNode> = {
    'getting-started': (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">Getting Started</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Cogitator is a self-hosted, production-grade AI agent orchestration platform.
          Think of it as Kubernetes for AI agents.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          {[
            { icon: '🚀', title: 'Quick Setup', desc: 'Get running in under 5 minutes' },
            { icon: '🔧', title: 'TypeScript Native', desc: 'Full type safety out of the box' },
            { icon: '🏠', title: 'Self-Hosted', desc: 'Your data, your infrastructure' },
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
    installation: (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Installation</h2>
        <p className="text-[#a1a1a1] mb-6">
          Install Cogitator using npm, pnpm, or yarn.
        </p>
        <CodeBlock language="bash">{`# Using pnpm (recommended)
pnpm add @cogitator/core @cogitator/dashboard

# Using npm
npm install @cogitator/core @cogitator/dashboard

# Using yarn
yarn add @cogitator/core @cogitator/dashboard`}</CodeBlock>
        <Callout type="tip">
          We recommend using pnpm for faster installs and better disk space efficiency.
        </Callout>
        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-4">Requirements</h3>
        <ul className="list-disc list-inside text-[#a1a1a1] space-y-2">
          <li>Node.js 20 or higher</li>
          <li>PostgreSQL 15+ (for persistence)</li>
          <li>Redis 7+ (for caching & queues)</li>
          <li>Docker (optional, for sandboxed code execution)</li>
        </ul>
      </>
    ),
    quickstart: (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Quick Start</h2>
        <p className="text-[#a1a1a1] mb-6">
          Create your first AI agent in minutes.
        </p>
        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-4">1. Initialize Cogitator</h3>
        <CodeBlock language="typescript">{`import { Cogitator } from '@cogitator/core';

const cogitator = new Cogitator({
  models: {
    ollama: { baseUrl: 'http://localhost:11434' },
    openai: { apiKey: process.env.OPENAI_API_KEY },
  },
  database: { url: process.env.DATABASE_URL },
  redis: { url: process.env.REDIS_URL },
});

await cogitator.initialize();`}</CodeBlock>
        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-4">2. Create an Agent</h3>
        <CodeBlock language="typescript">{`const researcher = await cogitator.agents.create({
  name: 'researcher',
  model: 'ollama/llama3.2',
  systemPrompt: \`You are a research assistant.
    Use the provided tools to search and analyze information.\`,
  tools: ['web_search', 'read_url', 'summarize'],
});`}</CodeBlock>
        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-4">3. Run the Agent</h3>
        <CodeBlock language="typescript">{`const result = await researcher.run({
  input: 'Research the latest developments in quantum computing',
});

console.log(result.output);
// "Quantum computing has seen significant advances in 2024..."`}</CodeBlock>
        <Callout type="info">
          Agents automatically handle retries, rate limits, and tool execution.
        </Callout>
      </>
    ),
    configuration: (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Configuration</h2>
        <p className="text-[#a1a1a1] mb-6">
          Configure Cogitator using environment variables or a config file.
        </p>
        <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-4">Environment Variables</h3>
        <CodeBlock language="bash">{`# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/cogitator

# Redis
REDIS_URL=redis://localhost:6379

# Model Providers
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_AI_API_KEY=...

# Ollama (local models)
OLLAMA_BASE_URL=http://localhost:11434

# Dashboard
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...

# Observability (optional)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=cogitator`}</CodeBlock>
        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-4">Configuration File</h3>
        <CodeBlock language="typescript">{`// cogitator.config.ts
import { defineConfig } from '@cogitator/core';

export default defineConfig({
  models: {
    default: 'ollama/llama3.2',
    providers: {
      ollama: { baseUrl: 'http://localhost:11434' },
      openai: { apiKey: process.env.OPENAI_API_KEY },
      anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
    },
  },
  memory: {
    provider: 'postgres',
    embeddings: 'ollama/nomic-embed-text',
  },
  sandbox: {
    executor: 'wasm', // or 'docker'
    timeout: 30000,
    maxMemory: '512mb',
  },
});`}</CodeBlock>
      </>
    ),
    agents: (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">Agents</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Agents are autonomous AI entities that can use tools, maintain memory, and accomplish complex tasks.
        </p>
        <div className="p-6 bg-gradient-to-br from-[#00ff88]/5 to-transparent border border-[#00ff88]/20 rounded-xl mb-8">
          <h3 className="text-[#00ff88] font-bold mb-2">Key Concepts</h3>
          <ul className="text-[#a1a1a1] space-y-1 text-sm">
            <li>• <strong className="text-[#fafafa]">Model:</strong> The LLM powering the agent (Ollama, OpenAI, Anthropic, etc.)</li>
            <li>• <strong className="text-[#fafafa]">Tools:</strong> Functions the agent can call to interact with the world</li>
            <li>• <strong className="text-[#fafafa]">Memory:</strong> Persistent state across conversations</li>
            <li>• <strong className="text-[#fafafa]">System Prompt:</strong> Instructions defining the agent&apos;s behavior</li>
          </ul>
        </div>
      </>
    ),
    'agent-basics': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Agent Basics</h2>
        <p className="text-[#a1a1a1] mb-6">
          Learn how to create and configure agents.
        </p>
        <CodeBlock language="typescript">{`import { Agent } from '@cogitator/core';

const agent = new Agent({
  name: 'assistant',
  model: 'anthropic/claude-3-sonnet',
  systemPrompt: 'You are a helpful assistant.',

  // Optional configuration
  temperature: 0.7,
  maxTokens: 4096,
  tools: ['calculator', 'web_search'],

  // Memory settings
  memory: {
    type: 'conversation',
    maxMessages: 50,
  },
});

// Run with streaming
for await (const chunk of agent.stream('Hello!')) {
  process.stdout.write(chunk.text);
}`}</CodeBlock>
        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-4">Agent Lifecycle</h3>
        <div className="flex items-center gap-2 text-sm font-mono text-[#666] mb-4">
          <span className="px-2 py-1 bg-[#111] rounded">create</span>
          <span>→</span>
          <span className="px-2 py-1 bg-[#111] rounded">initialize</span>
          <span>→</span>
          <span className="px-2 py-1 bg-[#00ff88]/20 text-[#00ff88] rounded">run</span>
          <span>→</span>
          <span className="px-2 py-1 bg-[#111] rounded">cleanup</span>
        </div>
      </>
    ),
    'agent-tools': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Tools & Functions</h2>
        <p className="text-[#a1a1a1] mb-6">
          Give agents the ability to interact with the world through tools.
        </p>
        <CodeBlock language="typescript">{`import { tool } from '@cogitator/core';
import { z } from 'zod';

// Define a custom tool
const weatherTool = tool({
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: z.object({
    location: z.string().describe('City name'),
    unit: z.enum(['celsius', 'fahrenheit']).default('celsius'),
  }),
  execute: async ({ location, unit }) => {
    const response = await fetch(\`https://api.weather.com/\${location}\`);
    const data = await response.json();
    return { temperature: data.temp, unit, conditions: data.conditions };
  },
});

// Use in an agent
const agent = new Agent({
  name: 'weather-bot',
  model: 'ollama/llama3.2',
  tools: [weatherTool, 'web_search', 'calculator'],
});`}</CodeBlock>
        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-4">Built-in Tools</h3>
        <div className="grid grid-cols-2 gap-2 text-sm">
          {[
            'web_search', 'read_url', 'calculator', 'code_execute',
            'file_read', 'file_write', 'json_parse', 'base64_encode',
          ].map((t) => (
            <div key={t} className="px-3 py-2 bg-[#111] border border-[#222] rounded font-mono text-[#00ff88]">
              {t}
            </div>
          ))}
        </div>
      </>
    ),
    'agent-memory': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Agent Memory</h2>
        <p className="text-[#a1a1a1] mb-6">
          Persist agent state and enable long-term memory.
        </p>
        <CodeBlock language="typescript">{`const agent = new Agent({
  name: 'persistent-assistant',
  model: 'openai/gpt-4',
  memory: {
    // Conversation memory (short-term)
    conversation: {
      maxMessages: 100,
      summarizeAfter: 50,
    },

    // Semantic memory (long-term)
    semantic: {
      provider: 'postgres',
      embeddings: 'openai/text-embedding-3-small',
      retrieveTop: 5,
    },

    // Working memory (task-specific)
    working: {
      persist: true,
    },
  },
});

// Memory is automatically managed
await agent.run('Remember that my favorite color is blue');
// Later...
const response = await agent.run('What is my favorite color?');
// "Your favorite color is blue!"`}</CodeBlock>
      </>
    ),
    workflows: (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">Workflows</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Orchestrate complex multi-step processes with DAG-based workflows.
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
                   │                                 │
                   └────────────────┬────────────────┘
                                    ▼
                              ┌─────────┐
                              │   END   │
                              └─────────┘`}
          </pre>
        </div>
      </>
    ),
    'workflow-basics': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Workflow Basics</h2>
        <CodeBlock language="typescript">{`import { Workflow } from '@cogitator/workflows';

const researchWorkflow = new Workflow({
  name: 'research-pipeline',
  nodes: [
    {
      id: 'search',
      type: 'agent',
      agent: 'researcher',
      input: '{{ input.query }}',
    },
    {
      id: 'analyze',
      type: 'agent',
      agent: 'analyst',
      input: '{{ nodes.search.output }}',
      dependsOn: ['search'],
    },
    {
      id: 'summarize',
      type: 'agent',
      agent: 'writer',
      input: '{{ nodes.analyze.output }}',
      dependsOn: ['analyze'],
    },
  ],
});

const result = await researchWorkflow.run({
  input: { query: 'Latest AI developments' },
});`}</CodeBlock>
      </>
    ),
    'workflow-nodes': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Node Types</h2>
        <div className="space-y-4">
          {[
            { type: 'agent', desc: 'Execute an AI agent', color: '#00ff88' },
            { type: 'tool', desc: 'Call a tool directly', color: '#00aaff' },
            { type: 'condition', desc: 'Branch based on conditions', color: '#ffaa00' },
            { type: 'parallel', desc: 'Execute nodes in parallel', color: '#aa00ff' },
            { type: 'loop', desc: 'Iterate over data', color: '#ff00aa' },
          ].map((node) => (
            <div key={node.type} className="flex items-center gap-4 p-4 bg-[#111] border border-[#222] rounded-lg">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: node.color }} />
              <code className="text-[#fafafa] font-mono">{node.type}</code>
              <span className="text-[#666]">—</span>
              <span className="text-[#a1a1a1]">{node.desc}</span>
            </div>
          ))}
        </div>
      </>
    ),
    'workflow-conditions': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Conditions & Branching</h2>
        <CodeBlock language="typescript">{`const workflow = new Workflow({
  name: 'conditional-pipeline',
  nodes: [
    {
      id: 'classify',
      type: 'agent',
      agent: 'classifier',
    },
    {
      id: 'route',
      type: 'condition',
      dependsOn: ['classify'],
      conditions: [
        {
          if: '{{ nodes.classify.output.category === "urgent" }}',
          then: 'urgent_handler',
        },
        {
          if: '{{ nodes.classify.output.category === "support" }}',
          then: 'support_handler',
        },
      ],
      else: 'default_handler',
    },
    { id: 'urgent_handler', type: 'agent', agent: 'urgent-responder' },
    { id: 'support_handler', type: 'agent', agent: 'support-agent' },
    { id: 'default_handler', type: 'agent', agent: 'general-assistant' },
  ],
});`}</CodeBlock>
      </>
    ),
    swarms: (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">Swarms</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Coordinate multiple agents working together on complex tasks.
        </p>
        <Callout type="tip">
          Swarms are ideal for tasks requiring diverse expertise, parallel processing, or consensus-based decisions.
        </Callout>
      </>
    ),
    'swarm-basics': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Swarm Basics</h2>
        <CodeBlock language="typescript">{`import { Swarm } from '@cogitator/swarms';

const reviewSwarm = new Swarm({
  name: 'code-review-swarm',
  agents: [
    { id: 'security', agent: 'security-reviewer' },
    { id: 'performance', agent: 'perf-reviewer' },
    { id: 'style', agent: 'style-reviewer' },
  ],
  coordination: 'parallel',
  aggregation: 'merge',
});

const result = await reviewSwarm.run({
  input: 'Review this code: ...',
});

// All agents run in parallel, results are merged`}</CodeBlock>
      </>
    ),
    'swarm-patterns': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Coordination Patterns</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[
            { name: 'Parallel', desc: 'All agents work simultaneously', icon: '⚡' },
            { name: 'Sequential', desc: 'Agents work one after another', icon: '→' },
            { name: 'Hierarchical', desc: 'Manager delegates to workers', icon: '👑' },
            { name: 'Debate', desc: 'Agents discuss until consensus', icon: '💬' },
          ].map((pattern) => (
            <div key={pattern.name} className="p-4 bg-[#111] border border-[#222] rounded-lg">
              <div className="text-2xl mb-2">{pattern.icon}</div>
              <h3 className="text-[#fafafa] font-semibold">{pattern.name}</h3>
              <p className="text-[#666] text-sm">{pattern.desc}</p>
            </div>
          ))}
        </div>
      </>
    ),
    'swarm-consensus': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Consensus Mechanisms</h2>
        <CodeBlock language="typescript">{`const debateSwarm = new Swarm({
  name: 'decision-swarm',
  agents: ['analyst-1', 'analyst-2', 'analyst-3'],
  coordination: 'debate',
  consensus: {
    type: 'majority',
    maxRounds: 5,
    moderator: 'senior-analyst',
  },
});

// Agents debate until majority agrees
const decision = await debateSwarm.run({
  input: 'Should we invest in this opportunity?',
});`}</CodeBlock>
      </>
    ),
    models: (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">Models</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Cogitator supports all major LLM providers with a unified interface.
        </p>
      </>
    ),
    'model-providers': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Model Providers</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {[
            { name: 'Ollama', desc: 'Local models', status: '✓', done: true },
            { name: 'OpenAI', desc: 'GPT-4, o1, o3', status: '✓', done: true },
            { name: 'Anthropic', desc: 'Claude 3/4', status: '✓', done: true },
            { name: 'Google', desc: 'Gemini', status: '✓', done: true },
            { name: 'Groq', desc: 'Fast inference', status: 'soon', done: false },
            { name: 'Together', desc: 'Open models', status: 'soon', done: false },
            { name: 'Mistral', desc: 'Mistral/Mixtral', status: 'soon', done: false },
            { name: 'xAI', desc: 'Grok', status: 'soon', done: false },
          ].map((p) => (
            <div key={p.name} className={`p-3 border rounded-lg text-center ${p.done ? 'bg-[#111] border-[#222]' : 'bg-[#0a0a0a] border-[#1a1a1a] opacity-60'}`}>
              <span className={`text-xs ${p.done ? 'text-[#00ff88]' : 'text-[#666]'}`}>{p.status}</span>
              <h3 className="text-[#fafafa] font-semibold">{p.name}</h3>
              <p className="text-[#666] text-xs">{p.desc}</p>
            </div>
          ))}
        </div>
        <CodeBlock language="typescript">{`// Use any model with a simple prefix
const agent = new Agent({
  model: 'ollama/llama3.2',      // Local Ollama
  // model: 'openai/gpt-4o',     // OpenAI
  // model: 'anthropic/claude-3-opus', // Anthropic
  // model: 'google/gemini-pro', // Google
});`}</CodeBlock>
      </>
    ),
    'model-ollama': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Ollama Integration</h2>
        <p className="text-[#a1a1a1] mb-6">
          Run models locally with Ollama for privacy and zero API costs.
        </p>
        <CodeBlock language="bash">{`# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull models
ollama pull llama3.2
ollama pull codellama
ollama pull nomic-embed-text  # for embeddings`}</CodeBlock>
        <CodeBlock language="typescript">{`// Configure Ollama in Cogitator
const cogitator = new Cogitator({
  models: {
    ollama: {
      baseUrl: 'http://localhost:11434',
      defaultModel: 'llama3.2',
    },
  },
});

// Use Ollama models
const agent = new Agent({
  model: 'ollama/llama3.2:70b',  // Specify variant
  temperature: 0.7,
});`}</CodeBlock>
        <Callout type="info">
          Ollama automatically manages GPU memory and model loading.
        </Callout>
      </>
    ),
    'model-pricing': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Pricing & Limits</h2>
        <p className="text-[#a1a1a1] mb-6">
          Cogitator tracks token usage and costs across all providers.
        </p>
        <CodeBlock language="typescript">{`// Enable cost tracking
const result = await agent.run('Complex task...', {
  trackCosts: true,
});

console.log(result.usage);
// {
//   inputTokens: 1234,
//   outputTokens: 567,
//   cost: 0.0023,  // USD
//   model: 'gpt-4o',
// }`}</CodeBlock>
        <div className="mt-6 p-4 bg-[#111] border border-[#222] rounded-lg">
          <p className="text-[#666] text-sm font-mono">
            💡 Use <code className="text-[#00ff88]">ollama/*</code> models for unlimited free local inference
          </p>
        </div>
      </>
    ),
    memory: (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">Memory & RAG</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Production-grade memory system with vector storage and RAG capabilities.
        </p>
      </>
    ),
    'memory-types': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Memory Types</h2>
        <div className="space-y-4">
          {[
            { type: 'Conversation', desc: 'Short-term chat history', ttl: 'Session' },
            { type: 'Semantic', desc: 'Long-term vector storage', ttl: 'Persistent' },
            { type: 'Working', desc: 'Task-specific context', ttl: 'Task duration' },
            { type: 'Episodic', desc: 'Event-based memories', ttl: 'Configurable' },
          ].map((m) => (
            <div key={m.type} className="flex items-center justify-between p-4 bg-[#111] border border-[#222] rounded-lg">
              <div>
                <h3 className="text-[#fafafa] font-semibold">{m.type}</h3>
                <p className="text-[#666] text-sm">{m.desc}</p>
              </div>
              <span className="px-2 py-1 text-xs bg-[#00ff88]/10 text-[#00ff88] rounded">{m.ttl}</span>
            </div>
          ))}
        </div>
      </>
    ),
    'memory-rag': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">RAG Pipeline</h2>
        <CodeBlock language="typescript">{`import { RAG } from '@cogitator/memory';

// Create RAG pipeline
const rag = new RAG({
  embeddings: 'openai/text-embedding-3-small',
  vectorStore: 'postgres',
  chunkSize: 512,
  chunkOverlap: 50,
});

// Index documents
await rag.index([
  { content: 'Document 1...', metadata: { source: 'file1.pdf' } },
  { content: 'Document 2...', metadata: { source: 'file2.md' } },
]);

// Query with context
const context = await rag.retrieve('What is the main topic?', {
  topK: 5,
  minScore: 0.7,
});

// Use in agent
const agent = new Agent({
  model: 'openai/gpt-4o',
  rag: rag,  // Automatically injects context
});`}</CodeBlock>
      </>
    ),
    'memory-vectors': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Vector Storage</h2>
        <p className="text-[#a1a1a1] mb-6">
          Cogitator supports multiple vector storage backends.
        </p>
        <div className="grid grid-cols-2 gap-4 mb-6">
          {[
            { name: 'PostgreSQL + pgvector', recommended: true },
            { name: 'Qdrant', recommended: false },
            { name: 'Pinecone', recommended: false },
            { name: 'In-Memory', recommended: false },
          ].map((v) => (
            <div key={v.name} className={`p-3 border rounded-lg ${v.recommended ? 'bg-[#00ff88]/5 border-[#00ff88]/30' : 'bg-[#111] border-[#222]'}`}>
              <span className="text-[#fafafa]">{v.name}</span>
              {v.recommended && <span className="ml-2 text-xs text-[#00ff88]">recommended</span>}
            </div>
          ))}
        </div>
      </>
    ),
    sandbox: (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">Code Sandbox</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Execute agent-generated code safely in isolated environments.
        </p>
        <Callout type="warning">
          Always sandbox untrusted code execution to prevent security issues.
        </Callout>
      </>
    ),
    'sandbox-docker': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Docker Executor</h2>
        <CodeBlock language="typescript">{`import { DockerSandbox } from '@cogitator/sandbox';

const sandbox = new DockerSandbox({
  image: 'python:3.11-slim',
  timeout: 30000,
  memory: '512mb',
  network: false,  // Disable network access
});

const result = await sandbox.execute({
  language: 'python',
  code: \`
import pandas as pd
df = pd.DataFrame({'a': [1,2,3], 'b': [4,5,6]})
print(df.describe())
  \`,
});

console.log(result.stdout);`}</CodeBlock>
      </>
    ),
    'sandbox-wasm': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">WASM Executor</h2>
        <p className="text-[#a1a1a1] mb-6">
          Lightweight, fast execution without Docker overhead.
        </p>
        <CodeBlock language="typescript">{`import { WasmSandbox } from '@cogitator/sandbox';

const sandbox = new WasmSandbox({
  timeout: 5000,
  memory: '128mb',
});

// Execute JavaScript
const result = await sandbox.execute({
  language: 'javascript',
  code: \`
const sum = [1, 2, 3, 4, 5].reduce((a, b) => a + b, 0);
console.log('Sum:', sum);
  \`,
});`}</CodeBlock>
        <Callout type="tip">
          WASM sandbox starts in milliseconds vs seconds for Docker.
        </Callout>
      </>
    ),
    'sandbox-security': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Security Model</h2>
        <div className="space-y-4">
          {[
            { feature: 'Process Isolation', docker: '✓', wasm: '✓' },
            { feature: 'Memory Limits', docker: '✓', wasm: '✓' },
            { feature: 'CPU Limits', docker: '✓', wasm: '✓' },
            { feature: 'Network Isolation', docker: '✓', wasm: '✓' },
            { feature: 'Filesystem Access', docker: 'Configurable', wasm: 'None' },
            { feature: 'System Calls', docker: 'Filtered', wasm: 'Blocked' },
          ].map((row) => (
            <div key={row.feature} className="flex items-center justify-between p-3 bg-[#111] border border-[#222] rounded-lg text-sm">
              <span className="text-[#fafafa]">{row.feature}</span>
              <div className="flex gap-4">
                <span className="text-[#00ff88] w-24 text-center">Docker: {row.docker}</span>
                <span className="text-[#00aaff] w-24 text-center">WASM: {row.wasm}</span>
              </div>
            </div>
          ))}
        </div>
      </>
    ),
    mcp: (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">MCP Protocol</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Model Context Protocol for standardized tool integration.
        </p>
      </>
    ),
    'mcp-overview': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Protocol Overview</h2>
        <p className="text-[#a1a1a1] mb-6">
          MCP provides a standardized way to connect AI models with external tools and data sources.
        </p>
        <div className="p-6 bg-[#111] border border-[#222] rounded-xl font-mono text-sm">
          <pre className="text-[#00ff88]">
{`Client (Cogitator)  ◄──────────►  MCP Server
        │                              │
        │  1. List Tools               │
        │  ───────────────────────►   │
        │                              │
        │  2. Tool Definitions         │
        │  ◄───────────────────────   │
        │                              │
        │  3. Execute Tool             │
        │  ───────────────────────►   │
        │                              │
        │  4. Tool Result              │
        │  ◄───────────────────────   │`}
          </pre>
        </div>
      </>
    ),
    'mcp-servers': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">MCP Servers</h2>
        <CodeBlock language="typescript">{`// Connect to MCP servers
const cogitator = new Cogitator({
  mcp: {
    servers: [
      {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
      },
      {
        name: 'github',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
      },
    ],
  },
});

// Tools from MCP servers are automatically available
const agent = new Agent({
  model: 'anthropic/claude-3-opus',
  tools: ['mcp:filesystem:*', 'mcp:github:*'],
});`}</CodeBlock>
      </>
    ),
    'mcp-tools': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Tool Registration</h2>
        <CodeBlock language="typescript">{`// Create your own MCP server
import { MCPServer } from '@cogitator/mcp';

const server = new MCPServer({
  name: 'my-tools',
  version: '1.0.0',
});

server.addTool({
  name: 'send_email',
  description: 'Send an email',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['to', 'subject', 'body'],
  },
  handler: async ({ to, subject, body }) => {
    await sendEmail(to, subject, body);
    return { success: true };
  },
});

server.start();`}</CodeBlock>
      </>
    ),
    api: (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">API Reference</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Cogitator exposes a REST API and OpenAI-compatible endpoints.
        </p>
      </>
    ),
    'api-rest': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">REST API</h2>
        <div className="space-y-4">
          {[
            { method: 'GET', path: '/api/agents', desc: 'List all agents' },
            { method: 'POST', path: '/api/agents', desc: 'Create agent' },
            { method: 'POST', path: '/api/agents/:id/run', desc: 'Run agent' },
            { method: 'GET', path: '/api/runs', desc: 'List runs' },
            { method: 'GET', path: '/api/runs/:id', desc: 'Get run details' },
            { method: 'GET', path: '/api/workflows', desc: 'List workflows' },
            { method: 'POST', path: '/api/workflows/:id/run', desc: 'Execute workflow' },
          ].map((ep) => (
            <div key={`${ep.method}-${ep.path}`} className="flex items-center gap-4 p-3 bg-[#111] border border-[#222] rounded-lg font-mono text-sm">
              <span className={`px-2 py-1 rounded text-xs ${ep.method === 'GET' ? 'bg-[#00aaff]/20 text-[#00aaff]' : 'bg-[#00ff88]/20 text-[#00ff88]'}`}>
                {ep.method}
              </span>
              <code className="text-[#fafafa]">{ep.path}</code>
              <span className="text-[#666] ml-auto">{ep.desc}</span>
            </div>
          ))}
        </div>
      </>
    ),
    'api-openai': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">OpenAI Compatible</h2>
        <p className="text-[#a1a1a1] mb-6">
          Use Cogitator as a drop-in replacement for OpenAI API.
        </p>
        <CodeBlock language="typescript">{`// Use with OpenAI SDK
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3000/api/v1',
  apiKey: 'not-needed',  // or your auth token
});

const response = await client.chat.completions.create({
  model: 'ollama/llama3.2',
  messages: [
    { role: 'user', content: 'Hello!' },
  ],
});`}</CodeBlock>
        <Callout type="info">
          Compatible with any OpenAI client library in any language.
        </Callout>
      </>
    ),
    'api-websocket': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">WebSocket Events</h2>
        <CodeBlock language="typescript">{`// Connect to real-time events
const ws = new WebSocket('ws://localhost:3000/api/events');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  switch (data.type) {
    case 'run.started':
      console.log('Run started:', data.runId);
      break;
    case 'run.step':
      console.log('Step:', data.step);
      break;
    case 'run.completed':
      console.log('Completed:', data.result);
      break;
    case 'run.error':
      console.error('Error:', data.error);
      break;
  }
};`}</CodeBlock>
      </>
    ),
    observability: (
      <>
        <h1 className="text-4xl font-bold text-[#fafafa] mb-4">Observability</h1>
        <p className="text-[#a1a1a1] text-lg mb-8">
          Production-grade observability with OpenTelemetry.
        </p>
      </>
    ),
    'obs-tracing': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Distributed Tracing</h2>
        <CodeBlock language="typescript">{`// Enable OpenTelemetry tracing
const cogitator = new Cogitator({
  observability: {
    tracing: {
      enabled: true,
      exporter: 'otlp',
      endpoint: 'http://localhost:4318',
    },
  },
});

// Traces include:
// - Agent execution spans
// - Tool calls
// - Model inference
// - Memory operations`}</CodeBlock>
        <div className="mt-6 p-4 bg-[#111] border border-[#222] rounded-lg">
          <p className="text-[#666] text-sm">
            Compatible with Jaeger, Zipkin, Grafana Tempo, and any OTLP collector.
          </p>
        </div>
      </>
    ),
    'obs-metrics': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Metrics & Prometheus</h2>
        <CodeBlock language="yaml">{`# Prometheus scrape config
scrape_configs:
  - job_name: 'cogitator'
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: /api/metrics`}</CodeBlock>
        <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-4">Available Metrics</h3>
        <div className="space-y-2 font-mono text-sm">
          {[
            'cogitator_agent_runs_total',
            'cogitator_agent_run_duration_seconds',
            'cogitator_model_tokens_total',
            'cogitator_model_cost_usd_total',
            'cogitator_tool_calls_total',
            'cogitator_memory_operations_total',
          ].map((m) => (
            <div key={m} className="px-3 py-2 bg-[#111] border border-[#222] rounded text-[#00ff88]">
              {m}
            </div>
          ))}
        </div>
      </>
    ),
    'obs-logging': (
      <>
        <h2 className="text-3xl font-bold text-[#fafafa] mb-4">Structured Logging</h2>
        <CodeBlock language="typescript">{`const cogitator = new Cogitator({
  observability: {
    logging: {
      level: 'info',  // debug, info, warn, error
      format: 'json', // json, pretty
      outputs: ['stdout', 'file'],
    },
  },
});

// Example log output
{
  "level": "info",
  "timestamp": "2024-01-15T10:30:00Z",
  "traceId": "abc123",
  "spanId": "def456",
  "message": "Agent run completed",
  "agent": "researcher",
  "duration": 1234,
  "tokens": { "input": 500, "output": 200 }
}`}</CodeBlock>
      </>
    ),
  };

  return (
    <div className="prose prose-invert max-w-none">
      {content[activeSection] || content['getting-started']}
    </div>
  );
}

export default function DocsPage() {
  const [activeSection, setActiveSection] = useState('getting-started');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash) setActiveSection(hash);
  }, []);

  const handleSectionClick = (id: string) => {
    setActiveSection(id);
    setMobileMenuOpen(false);
    window.history.pushState(null, '', `#${id}`);
  };

  const filteredSections = sections.filter((section) => {
    const query = searchQuery.toLowerCase();
    if (section.title.toLowerCase().includes(query)) return true;
    if (section.subsections?.some((s) => s.title.toLowerCase().includes(query))) return true;
    return false;
  });

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
            <span className="text-[#00ff88] font-mono text-sm hidden sm:block">docs</span>
          </div>

          <div className="flex items-center gap-4">
            <div className="relative hidden md:block">
              <input
                type="text"
                placeholder="Search docs..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-64 px-4 py-2 bg-[#111] border border-[#222] rounded-lg text-[#fafafa] text-sm placeholder-[#666] focus:outline-none focus:border-[#00ff88]"
              />
              <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[#444] text-xs">⌘K</kbd>
            </div>
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
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
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
            <div className="absolute inset-0 bg-black/50" onClick={() => setMobileMenuOpen(false)} />
            <div className="absolute left-0 top-0 bottom-0 w-72 bg-[#0a0a0a] border-r border-[#1a1a1a] pt-20 p-4 overflow-auto">
              {sections.map((section) => (
                <div key={section.id} className="mb-4">
                  <button
                    onClick={() => handleSectionClick(section.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg flex items-center gap-2 ${activeSection === section.id ? 'bg-[#00ff88]/10 text-[#00ff88]' : 'text-[#a1a1a1] hover:text-[#fafafa]'}`}
                  >
                    <span>{section.icon}</span>
                    <span>{section.title}</span>
                  </button>
                  {section.subsections?.map((sub) => (
                    <button
                      key={sub.id}
                      onClick={() => handleSectionClick(sub.id)}
                      className={`w-full text-left pl-10 pr-3 py-1 text-sm ${activeSection === sub.id ? 'text-[#00ff88]' : 'text-[#666] hover:text-[#a1a1a1]'}`}
                    >
                      {sub.title}
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
                  onClick={() => handleSectionClick(section.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg flex items-center gap-2 transition-colors ${
                    activeSection === section.id || section.subsections?.some((s) => s.id === activeSection)
                      ? 'bg-[#00ff88]/10 text-[#00ff88]'
                      : 'text-[#a1a1a1] hover:text-[#fafafa] hover:bg-[#111]'
                  }`}
                >
                  <span>{section.icon}</span>
                  <span className="font-medium">{section.title}</span>
                </button>
                {section.subsections && (
                  <div className="ml-4 mt-1 space-y-1">
                    {section.subsections.map((sub) => (
                      <button
                        key={sub.id}
                        onClick={() => handleSectionClick(sub.id)}
                        className={`w-full text-left pl-6 pr-3 py-1.5 rounded text-sm transition-colors ${
                          activeSection === sub.id
                            ? 'text-[#00ff88] bg-[#00ff88]/5'
                            : 'text-[#666] hover:text-[#a1a1a1]'
                        }`}
                      >
                        {sub.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </nav>
        </aside>

        <main className="flex-1 md:ml-72 min-h-screen">
          <div className="max-w-4xl mx-auto px-6 py-12">
            <motion.div
              key={activeSection}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
            >
              <DocsContent activeSection={activeSection} />
            </motion.div>

            <div className="mt-16 pt-8 border-t border-[#1a1a1a] flex items-center justify-between text-sm">
              <div className="text-[#666]">
                Was this helpful?{' '}
                <button className="text-[#00ff88] hover:underline ml-2">Yes</button>
                <button className="text-[#666] hover:text-[#fafafa] ml-2">No</button>
              </div>
              <div className="flex items-center gap-4">
                <a
                  href="https://discord.gg/SkmRsYvA"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#5865F2] hover:text-[#7289DA] flex items-center gap-1"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
                  </svg>
                  Discord
                </a>
                <a
                  href="https://github.com/cogitator/cogitator"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#666] hover:text-[#fafafa]"
                >
                  Edit on GitHub →
                </a>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
