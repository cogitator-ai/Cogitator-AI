import { code, tsString } from '../code.js';
import { runScript } from '../package-manager.js';
import type { ProjectBuilder } from '../project.js';
import { cogitatorVersion, VERSIONS } from '../versions.js';
import { startupImports, startupStatements } from './shared.js';
import type { FeatureModule } from './types.js';

const NEXT_PORT = 3000;

function nextConfig(project: ProjectBuilder): string {
  const cogitator = [...project.dependencies.keys()].filter(
    (name) => name.startsWith('@cogitator-ai/') && name !== '@cogitator-ai/next'
  );
  const external = [
    ...new Set([...cogitator, '@cogitator-ai/types', '@cogitator-ai/server-shared']),
    ...[...project.nativeBuilds].filter((name) => project.dependencies.has(name)),
  ].sort();
  return code`
    import type { NextConfig } from 'next';

    const config: NextConfig = {
      /**
       * Loaded by Node at runtime instead of bundled: they read files and native
       * modules, and one copy of each keeps \`instanceof\` working across packages.
       * @cogitator-ai/next stays bundled: its hooks need the app's own React.
       */
      serverExternalPackages: [${external.map((name) => tsString(name)).join(', ')}],
    };

    export default config;
  `;
}

const TSCONFIG_NEXT =
  JSON.stringify(
    {
      compilerOptions: {
        target: 'es2023',
        lib: ['dom', 'dom.iterable', 'es2024'],
        allowJs: false,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: 'react-jsx',
        incremental: true,
        plugins: [{ name: 'next' }],
        paths: { '@/*': ['./src/*'] },
      },
      include: ['next-env.d.ts', 'src', 'tests', 'evals', '*.config.ts', '.next/types/**/*.ts'],
      exclude: ['node_modules'],
    },
    null,
    2
  ) + '\n';

const POSTCSS_CONFIG = code`
  export default {
    plugins: { '@tailwindcss/postcss': {} },
  };
`;

const GLOBALS_CSS = code`
  @import "tailwindcss";

  @theme {
    --font-sans: ui-sans-serif, system-ui, sans-serif;
  }

  .prose-chat :where(p, ul, ol, pre) { margin-block: 0.5rem; }
  .prose-chat :where(ul) { list-style: disc; padding-left: 1.25rem; }
  .prose-chat :where(ol) { list-style: decimal; padding-left: 1.25rem; }
  .prose-chat :where(code) { font-size: 0.875em; }
  .prose-chat :where(pre) { overflow-x: auto; border-radius: 0.5rem; padding: 0.75rem; background: rgb(0 0 0 / 0.35); }
  .prose-chat :where(a) { text-decoration: underline; }
`;

function layoutTsx(project: ProjectBuilder): string {
  return code`
    import type { Metadata } from 'next';
    import type { ReactNode } from 'react';
    import './globals.css';

    export const metadata: Metadata = {
      title: ${tsString(project.spec.name)},
      description: 'A chat with your Cogitator agents',
    };

    export default function RootLayout({ children }: { children: ReactNode }) {
      return (
        <html lang="en" className="dark">
          <body className="bg-zinc-950 text-zinc-100 antialiased">{children}</body>
        </html>
      );
    }
  `;
}

const PAGE_TSX = code`
  import { Chat } from '@/components/chat';

  export default function Home() {
    return <Chat />;
  }
`;

const SESSION_TS = code`
  import { randomUUID } from 'node:crypto';
  import { cookies } from 'next/headers';

  const COOKIE = 'cogitator-user';

  /**
   * Who is chatting: an anonymous id in an httpOnly cookie, so every browser has
   * threads of its own. Replace this with your auth (Auth.js, Clerk, your SSO)
   * by returning your user's id instead.
   */
  export async function currentUser(): Promise<string> {
    const jar = await cookies();
    const existing = jar.get(COOKIE)?.value;
    if (existing) return existing;
    const id = randomUUID();
    jar.set(COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });
    return id;
  }
`;

function chatRouteTs(project: ProjectBuilder): string {
  return code`
    import { createChatHandler } from '@cogitator-ai/next';
    import { agents, cogitator } from '@/cogitator';
    import { currentUser } from '@/lib/session';
    ${startupImports(project)}

    ${startupStatements(project)}

    export const POST = createChatHandler(cogitator, agents.assistant, {
      beforeRun: async () => ({ userId: await currentUser() }),
    });
  `;
}

const RESUME_ROUTE_TS = code`
  import { createResumeHandler } from '@cogitator-ai/next';
  import { agents, cogitator } from '@/cogitator';
  import { currentUser } from '@/lib/session';

  export const POST = createResumeHandler(cogitator, agents.assistant, {
    stream: true,
    beforeRun: async () => ({ userId: await currentUser() }),
  });
`;

const THREAD_ROUTE_TS = code`
  import { assertThreadAccess, CogitatorError } from '@cogitator-ai/core';
  import type { ChatMessage } from '@cogitator-ai/next';
  import { cogitator } from '@/cogitator';
  import { currentUser } from '@/lib/session';

  function text(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((part: { type?: string; text?: string }) => (part.type === 'text' ? (part.text ?? '') : '')).join('');
  }

  /** The messages of one of the caller's threads, to show a saved conversation again. */
  export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const memory = await cogitator.getMemory();
    if (!memory) return Response.json({ messages: [] });

    try {
      const thread = await assertThreadAccess(memory, id, await currentUser());
      if (!thread) return Response.json({ messages: [] });
    } catch (error) {
      if (error instanceof CogitatorError) return Response.json({ error: error.message }, { status: 403 });
      throw error;
    }

    const entries = await memory.getEntries({ threadId: id, includeToolCalls: true });
    if (!entries.success) return Response.json({ error: entries.error }, { status: 500 });

    const messages: ChatMessage[] = entries.data
      .filter((entry) => entry.message.role === 'user' || entry.message.role === 'assistant')
      .map((entry): ChatMessage => ({
        id: entry.id,
        role: entry.message.role === 'user' ? 'user' : 'assistant',
        content: text(entry.message.content),
        ...(entry.toolCalls?.length && { toolCalls: entry.toolCalls }),
        createdAt: entry.createdAt,
      }))
      .filter((message) => message.content || message.toolCalls);
    return Response.json({ messages });
  }
`;

const HEALTH_ROUTE_TS = code`
  export function GET() {
    return Response.json({ status: 'ok' });
  }
`;

const CHAT_TSX = code`
  'use client';

  import type { ChatMessage } from '@cogitator-ai/next';
  import { useCogitatorChat } from '@cogitator-ai/next/client';
  import { type FormEvent, useEffect, useRef, useState } from 'react';
  import { Message } from './message';
  import { Threads, type SavedThread } from './threads';

  const THREADS_KEY = 'cogitator-threads';

  function loadThreads(): SavedThread[] {
    try {
      return JSON.parse(localStorage.getItem(THREADS_KEY) ?? '[]') as SavedThread[];
    } catch {
      return [];
    }
  }

  export function Chat() {
    const [threads, setThreads] = useState<SavedThread[]>([]);
    const [toolResults, setToolResults] = useState<Record<string, unknown>>({});
    const bottom = useRef<HTMLDivElement>(null);

    const chat = useCogitatorChat({
      api: '/api/chat',
      resumeApi: '/api/chat/resume',
      onToolResult: (event) => setToolResults((all) => ({ ...all, [event.toolCallId]: event.result })),
    });
    const { messages, input, setInput, send, stop, isLoading, error, threadId, pendingApprovals } = chat;

    useEffect(() => setThreads(loadThreads()), []);

    useEffect(() => {
      if (messages.length > 0) bottom.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    useEffect(() => {
      const first = messages.find((message) => message.role === 'user');
      if (!threadId || !first) return;
      setThreads((current) => {
        if (current.some((thread) => thread.id === threadId)) return current;
        const next = [{ id: threadId, title: first.content.slice(0, 60) }, ...current].slice(0, 50);
        localStorage.setItem(THREADS_KEY, JSON.stringify(next));
        return next;
      });
    }, [threadId, messages]);

    async function open(id: string) {
      const response = await fetch(\`/api/threads/\${encodeURIComponent(id)}\`);
      const body = (await response.json()) as { messages?: ChatMessage[] };
      chat.setMessages(body.messages ?? []);
      chat.setThreadId(id);
      setToolResults({});
    }

    function startNew() {
      chat.clearMessages();
      chat.setThreadId(undefined);
      setToolResults({});
    }

    function submit(event: FormEvent) {
      event.preventDefault();
      if (!input.trim() || isLoading) return;
      void send();
    }

    return (
      <div className="flex h-screen">
        <Threads threads={threads} current={threadId} onOpen={open} onNew={startNew} />
        <main className="flex flex-1 flex-col">
          <div className="flex-1 overflow-y-auto px-4 py-6">
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
              {messages.length === 0 && (
                <p className="mt-24 text-center text-zinc-500">Ask anything. The assistant can browse the web, do math and tell the time.</p>
              )}
              {messages.map((message) => (
                <Message key={message.id} message={message} toolResults={toolResults} />
              ))}
              {isLoading && <p className="text-sm text-zinc-500">Thinking...</p>}
              {pendingApprovals.length > 0 && (
                <div className="rounded-xl border border-amber-700 bg-amber-950/60 p-4 text-sm">
                  <p className="font-medium text-amber-200">The assistant wants to run:</p>
                  <ul className="mt-2 space-y-1">
                    {pendingApprovals.map((call) => (
                      <li key={call.toolCallId}>
                        <code>{call.toolName}</code> <code className="text-zinc-400">{JSON.stringify(call.arguments)}</code>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex gap-2">
                    <button type="button" className="rounded-lg bg-amber-600 px-3 py-1.5 font-medium" onClick={() => void chat.approve()}>
                      Approve
                    </button>
                    <button type="button" className="rounded-lg border border-zinc-600 px-3 py-1.5" onClick={() => void chat.deny('Declined in the chat')}>
                      Deny
                    </button>
                  </div>
                </div>
              )}
              {error && (
                <p className="rounded-xl border border-red-800 bg-red-950/60 px-4 py-2 text-sm text-red-200">{error.message}</p>
              )}
              <div ref={bottom} />
            </div>
          </div>
          <form onSubmit={submit} className="mx-auto flex w-full max-w-3xl gap-2 px-4 pb-6">
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Message the assistant"
              className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 outline-none focus:border-zinc-400"
            />
            {isLoading ? (
              <button type="button" onClick={stop} className="rounded-xl border border-zinc-600 px-5">
                Stop
              </button>
            ) : (
              <button type="submit" disabled={!input.trim()} className="rounded-xl bg-zinc-100 px-5 font-medium text-zinc-900 disabled:opacity-40">
                Send
              </button>
            )}
          </form>
        </main>
      </div>
    );
  }
`;

const MESSAGE_TSX = code`
  import type { ChatMessage } from '@cogitator-ai/next';
  import ReactMarkdown from 'react-markdown';

  export function Message({ message, toolResults }: { message: ChatMessage; toolResults: Record<string, unknown> }) {
    const mine = message.role === 'user';
    return (
      <div className={\`flex \${mine ? 'justify-end' : 'justify-start'}\`}>
        <div className={\`max-w-[85%] rounded-2xl px-4 py-2 \${mine ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-900'}\`}>
          {message.reasoning && (
            <details className="mb-2 text-sm text-zinc-400">
              <summary className="cursor-pointer">Reasoning</summary>
              <p className="mt-1 whitespace-pre-wrap">{message.reasoning}</p>
            </details>
          )}
          {message.toolCalls?.map((call) => (
            <details key={call.id} className="mb-2 rounded-lg border border-zinc-800 px-3 py-2 text-sm">
              <summary className="cursor-pointer font-mono text-zinc-300">{call.name}</summary>
              <pre className="mt-2 overflow-x-auto text-xs text-zinc-400">{JSON.stringify(call.arguments, null, 2)}</pre>
              {call.id in toolResults && (
                <pre className="mt-2 overflow-x-auto text-xs text-zinc-300">{JSON.stringify(toolResults[call.id], null, 2)}</pre>
              )}
            </details>
          ))}
          <div className="prose-chat">
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        </div>
      </div>
    );
  }
`;

const THREADS_TSX = code`
  export interface SavedThread {
    id: string;
    title: string;
  }

  export function Threads({
    threads,
    current,
    onOpen,
    onNew,
  }: {
    threads: SavedThread[];
    current: string | undefined;
    onOpen: (id: string) => void;
    onNew: () => void;
  }) {
    return (
      <aside className="hidden w-64 flex-col border-r border-zinc-800 p-3 md:flex">
        <button type="button" onClick={onNew} className="mb-3 rounded-lg border border-zinc-700 px-3 py-2 text-left text-sm">
          New chat
        </button>
        <nav className="flex flex-col gap-1 overflow-y-auto">
          {threads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              onClick={() => onOpen(thread.id)}
              className={\`truncate rounded-lg px-3 py-2 text-left text-sm \${thread.id === current ? 'bg-zinc-800' : 'hover:bg-zinc-900'}\`}
            >
              {thread.title}
            </button>
          ))}
        </nav>
      </aside>
    );
  }
`;

const SAVE_NOTE_TS = code`
  import { appendFile, mkdir } from 'node:fs/promises';
  import { tool } from '@cogitator-ai/core';
  import { z } from 'zod';

  /** Saves a note to data/notes.md. It changes a file, so the chat asks you to approve it first. */
  export const saveNote = tool({
    name: 'save_note',
    description: 'Save a note for the user to read later.',
    parameters: z.object({ text: z.string().min(1).max(2_000).describe('The note') }),
    sideEffects: ['filesystem'],
    requiresApproval: true,
    execute: async ({ text }) => {
      await mkdir('data', { recursive: true });
      await appendFile('data/notes.md', \`- \${new Date().toISOString()} \${text}\\n\`);
      return { saved: true };
    },
  });
`;

/** A Next.js chat app: streaming, tool calls, approvals and saved threads, with the agents on the server. */
export const appNextFeature: FeatureModule = {
  id: 'app:next',
  applies: (spec) => spec.app === 'next',
  apply(project) {
    project
      .dependency('@cogitator-ai/next', cogitatorVersion('@cogitator-ai/next'))
      .dependency('next', VERSIONS.next)
      .dependency('react', VERSIONS.react)
      .dependency('react-dom', VERSIONS.reactDom)
      .dependency('react-markdown', VERSIONS.reactMarkdown)
      .devDependency('typescript', VERSIONS.typescriptNext)
      .devDependency('@types/react', VERSIONS.typesReact)
      .devDependency('@types/react-dom', VERSIONS.typesReactDom)
      .devDependency('tailwindcss', VERSIONS.tailwind)
      .devDependency('@tailwindcss/postcss', VERSIONS.tailwindPostcss)
      .file('tsconfig.json', TSCONFIG_NEXT)
      .file('postcss.config.mjs', POSTCSS_CONFIG)
      .file('src/app/globals.css', GLOBALS_CSS)
      .file('src/app/layout.tsx', layoutTsx(project))
      .file('src/app/page.tsx', PAGE_TSX)
      .file('src/lib/session.ts', SESSION_TS)
      .file('src/app/api/chat/resume/route.ts', RESUME_ROUTE_TS)
      .file('src/app/api/threads/[id]/route.ts', THREAD_ROUTE_TS)
      .file('src/app/api/health/route.ts', HEALTH_ROUTE_TS)
      .file('src/components/chat.tsx', CHAT_TSX)
      .file('src/components/message.tsx', MESSAGE_TSX)
      .file('src/components/threads.tsx', THREADS_TSX)
      .file('src/tools/save-note.ts', SAVE_NOTE_TS)
      .tool('saveNote', './save-note.js')
      .script('dev', 'next dev')
      .script('build', 'next build')
      .script('start', 'next start')
      .ignore('.next/', 'out/', 'next-env.d.ts', 'data/')
      .instruct(
        'You chat in a web page that renders Markdown, so format answers with Markdown when it helps.'
      );
    project.deploy.kind = 'server';
    project.deploy.port = NEXT_PORT;
    project.deploy.healthPath = '/api/health';
  },
  finalize(project) {
    project
      .file('next.config.ts', nextConfig(project))
      .file('src/app/api/chat/route.ts', chatRouteTs(project));
    const pm = project.spec.packageManager;
    project.section(
      'Next.js app',
      code`
        \`src/app/api/chat/route.ts\` streams the assistant with \`createChatHandler\`, \`src/app/api/chat/resume/route.ts\` continues a run after an approval, and \`src/app/api/threads/[id]/route.ts\` loads a saved conversation after checking it belongs to the caller. \`src/lib/session.ts\` identifies the caller with an anonymous cookie: replace it with your auth. \`src/components/chat.tsx\` is the client (\`useCogitatorChat\`): Markdown, tool calls with their results, reasoning, approvals for \`save_note\`, stop, and threads kept in the sidebar. \`${runScript(pm, 'dev')}\` serves it on http://localhost:${NEXT_PORT}.
      `
    );
  },
};
