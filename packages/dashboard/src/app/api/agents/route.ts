import { NextResponse } from 'next/server';
import { getAgents, createAgent, initializeExtendedSchema } from '@/lib/cogitator/db';
import { initializeSchema } from '@/lib/db';
import { getAvailableTools } from '@/lib/cogitator';
import { withAuth } from '@/lib/auth/middleware';
import { createAgentSchema } from '@/lib/validation';

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    try {
      await initializeSchema();
      await initializeExtendedSchema();
      initialized = true;
      console.log('[api/agents] Database initialized');
    } catch (error) {
      console.error('[api/agents] Failed to initialize database:', error);
    }
  }
}

export const GET = withAuth(async () => {
  try {
    await ensureInitialized();
    const agents = await getAgents();
    return NextResponse.json(agents);
  } catch (error) {
    console.error('[api/agents] Failed to fetch agents:', error);
    return NextResponse.json({ error: 'Failed to fetch agents' }, { status: 500 });
  }
});

export const POST = withAuth(async (request) => {
  try {
    await ensureInitialized();
    const body = await request.json();

    const parsed = createAgentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          details: parsed.error.issues.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        },
        { status: 400 }
      );
    }

    const availableToolNames = getAvailableTools().map((t) => t.name);
    const invalidTools = (parsed.data.tools || []).filter(
      (t: string) => !availableToolNames.includes(t)
    );
    if (invalidTools.length > 0) {
      return NextResponse.json(
        { error: `Invalid tools: ${invalidTools.join(', ')}` },
        { status: 400 }
      );
    }

    const agent = await createAgent({
      name: parsed.data.name,
      model: parsed.data.model,
      instructions: parsed.data.instructions,
      description: body.description,
      temperature: parsed.data.temperature,
      topP: body.topP,
      maxTokens: parsed.data.maxTokens,
      tools: parsed.data.tools,
      memoryEnabled: body.memoryEnabled,
      maxIterations: body.maxIterations,
      timeout: body.timeout,
      responseFormat: body.responseFormat,
    });

    return NextResponse.json(agent, { status: 201 });
  } catch (error) {
    console.error('[api/agents] Failed to create agent:', error);
    return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 });
  }
});
