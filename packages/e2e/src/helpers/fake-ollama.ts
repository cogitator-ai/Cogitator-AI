import { createServer, type Server } from 'node:http';

export interface FakeMessage {
  role: string;
  content: string;
  tool_name?: string;
}

/** What the fake model answers to a conversation. */
export interface FakeReply {
  content?: string;
  thinking?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

export interface FakeOllama {
  url: string;
  /** Every chat request the server answered. */
  requests: Array<{ model: string; messages: FakeMessage[]; tools: string[] }>;
  close(): Promise<void>;
}

/**
 * An Ollama server for tests: answers /api/chat (streamed as NDJSON or in
 * one response) from a script instead of a model, and /api/tags with the
 * models it claims to have. Projects reach it through OLLAMA_BASE_URL.
 */
export async function startFakeOllama(
  reply: (messages: FakeMessage[]) => FakeReply,
  models: string[] = ['qwen3.5:4b']
): Promise<FakeOllama> {
  const requests: FakeOllama['requests'] = [];
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          models: models.map((name) => ({
            name,
            model: name,
            size: 1_000_000,
            modified_at: new Date().toISOString(),
          })),
        })
      );
      return;
    }
    if (req.method !== 'POST' || req.url !== '/api/chat') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const request = JSON.parse(body) as {
        model: string;
        messages: FakeMessage[];
        tools?: Array<{ function: { name: string } }>;
        stream?: boolean;
      };
      requests.push({
        model: request.model,
        messages: request.messages,
        tools: (request.tools ?? []).map((tool) => tool.function.name),
      });
      const answer = reply(request.messages);
      const toolCalls = answer.toolCalls?.map((call, i) => ({
        id: `call_${requests.length}_${i}`,
        function: { name: call.name, arguments: call.arguments },
      }));
      const done = {
        model: request.model,
        created_at: new Date().toISOString(),
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 12,
        eval_count: 7,
      };
      if (request.stream === false) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            ...done,
            message: {
              role: 'assistant',
              content: answer.content ?? '',
              ...(answer.thinking && { thinking: answer.thinking }),
              ...(toolCalls && { tool_calls: toolCalls }),
            },
          })
        );
        return;
      }
      res.setHeader('content-type', 'application/x-ndjson');
      const line = (value: unknown) => res.write(`${JSON.stringify(value)}\n`);
      const base = { model: request.model, created_at: new Date().toISOString(), done: false };
      if (answer.thinking)
        line({ ...base, message: { role: 'assistant', content: '', thinking: answer.thinking } });
      for (const word of (answer.content ?? '').split(/(?<= )/)) {
        if (word) line({ ...base, message: { role: 'assistant', content: word } });
      }
      if (toolCalls)
        line({ ...base, message: { role: 'assistant', content: '', tool_calls: toolCalls } });
      line({ ...done, message: { role: 'assistant', content: '' } });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
