import { NextResponse } from 'next/server';
import { getAvailableTools } from '@/lib/cogitator';

export async function GET() {
  try {
    const tools = getAvailableTools();

    const toolsData = tools.map((tool) => {
      const schema = tool.toJSON();
      return {
        name: tool.name,
        description: tool.description,
        parameters: schema.parameters,
        requiresApproval: tool.requiresApproval ?? false,
        sandbox: tool.sandbox,
        timeout: tool.timeout,
      };
    });

    return NextResponse.json(toolsData);
  } catch (error) {
    console.error('[api/tools] Failed to fetch tools:', error);
    return NextResponse.json({ error: 'Failed to fetch tools' }, { status: 500 });
  }
}
