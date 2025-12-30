import { NextRequest, NextResponse } from 'next/server';
import { getAgent, updateAgent, deleteAgent, getRuns } from '@/lib/cogitator/db';
import { getAvailableTools } from '@/lib/cogitator';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const agent = await getAgent(id);

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const runs = await getRuns({ agentId: id, limit: 20 });

    return NextResponse.json({ ...agent, recentRuns: runs });
  } catch (error) {
    console.error('[api/agents] Failed to fetch agent:', error);
    return NextResponse.json({ error: 'Failed to fetch agent' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await request.json();

    if (body.tools) {
      const availableToolNames = getAvailableTools().map((t) => t.name);
      const invalidTools = body.tools.filter(
        (t: string) => !availableToolNames.includes(t)
      );
      if (invalidTools.length > 0) {
        return NextResponse.json(
          { error: `Invalid tools: ${invalidTools.join(', ')}` },
          { status: 400 }
        );
      }
    }

    const agent = await updateAgent(id, {
      name: body.name,
      description: body.description,
      model: body.model,
      instructions: body.instructions,
      temperature: body.temperature,
      topP: body.topP,
      maxTokens: body.maxTokens,
      tools: body.tools,
      memoryEnabled: body.memoryEnabled,
      maxIterations: body.maxIterations,
      timeout: body.timeout,
      responseFormat: body.responseFormat,
    });

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    return NextResponse.json(agent);
  } catch (error) {
    console.error('[api/agents] Failed to update agent:', error);
    return NextResponse.json({ error: 'Failed to update agent' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const deleted = await deleteAgent(id);

    if (!deleted) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[api/agents] Failed to delete agent:', error);
    return NextResponse.json({ error: 'Failed to delete agent' }, { status: 500 });
  }
}
