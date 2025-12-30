import { NextRequest } from 'next/server';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const { name } = await request.json();
  
  if (!name) {
    return new Response(JSON.stringify({ error: 'Model name required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const response = await fetch(`${OLLAMA_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
    });

    if (!response.ok || !response.body) {
      return new Response(JSON.stringify({ error: 'Failed to pull model' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const encoder = new TextEncoder();
    const reader = response.body.getReader();
    
    const stream = new ReadableStream({
      async start(controller) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.enqueue(encoder.encode('data: {"status":"done"}\n\n'));
            controller.close();
            break;
          }
          
          const text = new TextDecoder().decode(value);
          const lines = text.split('\n').filter(Boolean);
          
          for (const line of lines) {
            try {
              const progress = JSON.parse(line);
              
              if (progress.total && progress.completed) {
                progress.percent = Math.round((progress.completed / progress.total) * 100);
              }
              
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(progress)}\n\n`));
            } catch {
            }
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Failed to pull model:', error);
    return new Response(JSON.stringify({ error: 'Failed to connect to Ollama' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

