import { query, queryOne, execute } from './index';
import { nanoid } from 'nanoid';
import type { TraceSpan } from '@/types';

interface SpanRow {
  id: string;
  run_id: string;
  trace_id: string;
  parent_id: string | null;
  name: string;
  kind: string;
  status: 'ok' | 'error' | 'unset';
  start_time: string;
  end_time: string | null;
  duration: number | null;
  attributes: Record<string, unknown> | null;
  events: Array<{ name: string; timestamp: number; attributes?: Record<string, unknown> }> | null;
}

function rowToSpan(row: SpanRow): TraceSpan {
  return {
    id: row.id,
    traceId: row.trace_id,
    parentId: row.parent_id || undefined,
    name: row.name,
    kind: row.kind,
    status: row.status,
    startTime: parseInt(row.start_time),
    endTime: row.end_time ? parseInt(row.end_time) : undefined,
    duration: row.duration || undefined,
    attributes: row.attributes || {},
    events: row.events || [],
    children: [],
  };
}

export async function getSpansByRunId(runId: string): Promise<TraceSpan[]> {
  const rows = await query<SpanRow>(
    'SELECT * FROM dashboard_spans WHERE run_id = $1 ORDER BY start_time',
    [runId]
  );
  
  const spans = rows.map(rowToSpan);
  return buildSpanTree(spans);
}

export async function getSpansByTraceId(traceId: string): Promise<TraceSpan[]> {
  const rows = await query<SpanRow>(
    'SELECT * FROM dashboard_spans WHERE trace_id = $1 ORDER BY start_time',
    [traceId]
  );
  
  const spans = rows.map(rowToSpan);
  return buildSpanTree(spans);
}

function buildSpanTree(spans: TraceSpan[]): TraceSpan[] {
  const spanMap = new Map<string, TraceSpan>();
  const roots: TraceSpan[] = [];

  for (const span of spans) {
    spanMap.set(span.id, { ...span, children: [] });
  }

  for (const span of spans) {
    const node = spanMap.get(span.id)!;
    if (span.parentId) {
      const parent = spanMap.get(span.parentId);
      if (parent) {
        parent.children = parent.children || [];
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    } else {
      roots.push(node);
    }
  }

  return roots;
}

export async function createSpan(data: {
  runId: string;
  traceId: string;
  parentId?: string;
  name: string;
  kind?: string;
  startTime: number;
  attributes?: Record<string, unknown>;
}): Promise<string> {
  const id = `span_${nanoid(12)}`;
  
  await execute(
    `INSERT INTO dashboard_spans (id, run_id, trace_id, parent_id, name, kind, start_time, attributes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      data.runId,
      data.traceId,
      data.parentId || null,
      data.name,
      data.kind || 'internal',
      data.startTime,
      data.attributes ? JSON.stringify(data.attributes) : null,
    ]
  );

  return id;
}

export async function endSpan(id: string, data: {
  status: 'ok' | 'error' | 'unset';
  endTime: number;
  attributes?: Record<string, unknown>;
  events?: Array<{ name: string; timestamp: number; attributes?: Record<string, unknown> }>;
}): Promise<void> {
  const span = await queryOne<SpanRow>(
    'SELECT start_time FROM dashboard_spans WHERE id = $1',
    [id]
  );
  
  if (!span) return;

  const duration = data.endTime - parseInt(span.start_time);

  await execute(
    `UPDATE dashboard_spans 
     SET status = $1, end_time = $2, duration = $3, 
         attributes = COALESCE(attributes, '{}'::jsonb) || $4::jsonb,
         events = $5
     WHERE id = $6`,
    [
      data.status,
      data.endTime,
      duration,
      data.attributes ? JSON.stringify(data.attributes) : '{}',
      data.events ? JSON.stringify(data.events) : null,
      id,
    ]
  );
}

export async function addSpanEvent(id: string, event: {
  name: string;
  timestamp: number;
  attributes?: Record<string, unknown>;
}): Promise<void> {
  await execute(
    `UPDATE dashboard_spans 
     SET events = COALESCE(events, '[]'::jsonb) || $1::jsonb
     WHERE id = $2`,
    [JSON.stringify([event]), id]
  );
}

