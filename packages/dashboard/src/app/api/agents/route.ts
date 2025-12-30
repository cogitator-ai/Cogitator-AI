import { NextRequest, NextResponse } from 'next/server';
import {
  getAgents,
  createAgent,
  initializeExtendedSchema,
} from '@/lib/cogitator/db';
import { initializeSchema } from '@/lib/db';
import { getAvailableTools } from '@/lib/cogitator';

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

export async function GET() {
  try {
    await ensureInitialized();
    const agents = await getAgents();
    return NextResponse.json(agents);
  } catch (error) {
    console.error('[api/agents] Failed to fetch agents:', error);
    return NextResponse.json({ error: 'Failed to fetch agents' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await ensureInitialized();
    const body = await request.json();

    if (!body.name || !body.model || !body.instructions) {
      return NextResponse.json(
        { error: 'Name, model, and instructions are required' },
        { status: 400 }
      );
    }

    // Validate tools exist
    const availableToolNames = getAvailableTools().map((t) => t.name);
    const invalidTools = (body.tools || []).filter(
      (t: string) => !availableToolNames.includes(t)
    );
    if (invalidTools.length > 0) {
      return NextResponse.json(
        { error: `Invalid tools: ${invalidTools.join(', ')}` },
        { status: 400 }
      );
    }

    const agent = await createAgent({
      name: body.name,
      model: body.model,
      instructions: body.instructions,
      description: body.description,
      temperature: body.temperature,
      topP: body.topP,
      maxTokens: body.maxTokens,
      tools: body.tools,
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
}
