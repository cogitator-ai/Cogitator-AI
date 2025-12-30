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

export async function GET(request: NextRequest) {
  try {
    await ensureInitialized();

    const searchParams = request.nextUrl.searchParams;
    const limit = parseInt(searchParams.get('limit') || '50');
    const offset = parseInt(searchParams.get('offset') || '0');
    const search = searchParams.get('search') || undefined;

    const result = await getWorkflows({ limit, offset, search });

    return NextResponse.json({
      workflows: result.workflows,
      total: result.total,
      limit,
      offset,
    });
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

