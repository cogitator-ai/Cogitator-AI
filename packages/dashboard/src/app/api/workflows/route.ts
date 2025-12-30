import { NextRequest, NextResponse } from 'next/server';
import {
  getWorkflows,
  createWorkflow,
  initializeExtendedSchema,
} from '@/lib/cogitator/db';
import { initializeSchema } from '@/lib/db';

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    try {
      await initializeSchema();
      await initializeExtendedSchema();
      initialized = true;
    } catch (error) {
      console.error('[api/workflows] Failed to initialize database:', error);
    }
  }
}

export async function GET() {
  try {
    await ensureInitialized();
    const workflows = await getWorkflows();
    return NextResponse.json(workflows);
  } catch (error) {
    console.error('[api/workflows] Failed to fetch workflows:', error);
    return NextResponse.json(
      { error: 'Failed to fetch workflows' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await ensureInitialized();
    const body = await request.json();

    if (!body.name || !body.definition) {
      return NextResponse.json(
        { error: 'Name and definition are required' },
        { status: 400 }
      );
    }

    const workflow = await createWorkflow({
      name: body.name,
      description: body.description,
      definition: body.definition,
      initialState: body.initialState,
      triggers: body.triggers,
    });

    return NextResponse.json(workflow, { status: 201 });
  } catch (error) {
    console.error('[api/workflows] Failed to create workflow:', error);
    return NextResponse.json(
      { error: 'Failed to create workflow' },
      { status: 500 }
    );
  }
}

