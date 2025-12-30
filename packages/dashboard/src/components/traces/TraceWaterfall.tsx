'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import { Activity } from 'lucide-react';
import type { TraceSpan } from '@/types';

interface TraceWaterfallProps {
  spans: TraceSpan[];
}

const COLORS = [
  'bg-accent',
  'bg-chart-2',
  'bg-chart-3',
  'bg-chart-4',
  'bg-chart-5',
];

export function TraceWaterfall({ spans }: TraceWaterfallProps) {
  const [selectedSpan, setSelectedSpan] = useState<TraceSpan | null>(null);

  if (!spans || spans.length === 0) {
    return (
      <Card className="text-center py-12">
        <Activity className="w-12 h-12 mx-auto mb-4 text-text-muted opacity-50" />
        <h3 className="text-lg font-medium text-text-primary mb-2">
          No trace data available
        </h3>
        <p className="text-text-secondary">
          Spans will appear here once the agent execution is traced.
        </p>
      </Card>
    );
  }

  const flattenedSpans = flattenSpanTree(spans);
  
  const minTime = Math.min(...flattenedSpans.map((s) => s.startTime));
  const maxTime = Math.max(...flattenedSpans.map((s) => s.endTime || s.startTime + (s.duration || 0)));
  const totalDuration = maxTime - minTime;

  const depthMap = buildDepthMap(spans);

  const getSpanColor = (depth: number) => COLORS[depth % COLORS.length];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Waterfall */}
      <Card padding="none" className="lg:col-span-2">
        <CardHeader className="px-4 pt-4">
          <CardTitle>Trace Timeline</CardTitle>
          <span className="text-xs text-text-tertiary">
            Total: {(totalDuration / 1000).toFixed(2)}s • {flattenedSpans.length} spans
          </span>
        </CardHeader>

        {/* Time ruler */}
        <div className="px-4 py-2 border-b border-border-subtle">
          <div className="flex justify-between text-xs text-text-muted ml-48">
            <span>0ms</span>
            <span>{(totalDuration / 4).toFixed(0)}ms</span>
            <span>{(totalDuration / 2).toFixed(0)}ms</span>
            <span>{((totalDuration * 3) / 4).toFixed(0)}ms</span>
            <span>{totalDuration.toFixed(0)}ms</span>
          </div>
        </div>

        {/* Spans */}
        <div className="divide-y divide-border-subtle max-h-[500px] overflow-y-auto">
          {flattenedSpans.map((span) => {
            const depth = depthMap.get(span.id) || 0;
            const left = totalDuration > 0 
              ? ((span.startTime - minTime) / totalDuration) * 100 
              : 0;
            const duration = span.duration || (span.endTime ? span.endTime - span.startTime : 0);
            const width = totalDuration > 0 
              ? (duration / totalDuration) * 100 
              : 1;
            const isSelected = selectedSpan?.id === span.id;

            return (
              <button
                key={span.id}
                onClick={() => setSelectedSpan(span)}
                className={cn(
                  'w-full px-4 py-3 flex items-center gap-4 hover:bg-bg-hover transition-colors text-left',
                  isSelected && 'bg-bg-hover'
                )}
              >
                {/* Name */}
                <div
                  className="w-44 flex-shrink-0 truncate text-sm"
                  style={{ paddingLeft: `${depth * 16}px` }}
                >
                  <span className="text-text-primary">{span.name}</span>
                </div>

                {/* Timeline bar */}
                <div className="flex-1 h-6 relative bg-bg-tertiary/30 rounded">
                  <div
                    className={cn(
                      'absolute h-full rounded-sm transition-all',
                      getSpanColor(depth),
                      span.status === 'error' && 'bg-error',
                      isSelected && 'ring-2 ring-accent ring-offset-2 ring-offset-bg-secondary'
                    )}
                    style={{
                      left: `${left}%`,
                      width: `${Math.max(width, 0.5)}%`,
                    }}
                  />
                </div>

                {/* Duration */}
                <span className="w-16 text-xs text-text-tertiary text-right">
                  {duration.toFixed(0)}ms
                </span>
              </button>
            );
          })}
        </div>
      </Card>

      {/* Span Details */}
      <Card>
        <CardHeader>
          <CardTitle>Span Details</CardTitle>
        </CardHeader>

        {selectedSpan ? (
          <div className="space-y-4">
            <div>
              <p className="text-xs text-text-tertiary mb-1">Name</p>
              <p className="text-sm text-text-primary font-mono">
                {selectedSpan.name}
              </p>
            </div>

            <div className="flex gap-4">
              <div>
                <p className="text-xs text-text-tertiary mb-1">Duration</p>
                <p className="text-sm text-text-primary">
                  {(selectedSpan.duration || 0).toFixed(0)}ms
                </p>
              </div>
              <div>
                <p className="text-xs text-text-tertiary mb-1">Status</p>
                <Badge
                  variant={selectedSpan.status === 'ok' ? 'success' : selectedSpan.status === 'error' ? 'error' : 'warning'}
                  size="sm"
                >
                  {selectedSpan.status}
                </Badge>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-text-tertiary mb-1">Start Time</p>
                <p className="text-sm text-text-primary">
                  {selectedSpan.startTime}ms
                </p>
              </div>
              {selectedSpan.endTime && (
                <div>
                  <p className="text-xs text-text-tertiary mb-1">End Time</p>
                  <p className="text-sm text-text-primary">
                    {selectedSpan.endTime}ms
                  </p>
                </div>
              )}
            </div>

            <div>
              <p className="text-xs text-text-tertiary mb-1">Kind</p>
              <p className="text-sm text-text-primary">{selectedSpan.kind}</p>
            </div>

            {selectedSpan.traceId && (
              <div>
                <p className="text-xs text-text-tertiary mb-1">Trace ID</p>
                <p className="text-xs text-text-primary font-mono truncate">
                  {selectedSpan.traceId}
                </p>
              </div>
            )}

            {selectedSpan.parentId && (
              <div>
                <p className="text-xs text-text-tertiary mb-1">Parent ID</p>
                <p className="text-xs text-text-primary font-mono truncate">
                  {selectedSpan.parentId}
                </p>
              </div>
            )}

            {Object.keys(selectedSpan.attributes || {}).length > 0 && (
              <div>
                <p className="text-xs text-text-tertiary mb-2">Attributes</p>
                <div className="bg-bg-elevated rounded-lg p-3 space-y-2 max-h-48 overflow-y-auto">
                  {Object.entries(selectedSpan.attributes).map(([key, value]) => (
                    <div key={key} className="flex justify-between text-xs gap-2">
                      <span className="text-text-tertiary truncate">{key}</span>
                      <span className="text-text-primary font-mono truncate max-w-[60%]">
                        {formatAttributeValue(value)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selectedSpan.events && selectedSpan.events.length > 0 && (
              <div>
                <p className="text-xs text-text-tertiary mb-2">Events ({selectedSpan.events.length})</p>
                <div className="bg-bg-elevated rounded-lg p-3 space-y-2 max-h-32 overflow-y-auto">
                  {selectedSpan.events.map((event, i) => (
                    <div key={i} className="text-xs">
                      <span className="text-text-primary">{event.name}</span>
                      <span className="text-text-muted ml-2">
                        @{event.timestamp}ms
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-text-tertiary">
            Click on a span to view details
          </p>
        )}
      </Card>
    </div>
  );
}

function flattenSpanTree(spans: TraceSpan[], result: TraceSpan[] = []): TraceSpan[] {
  for (const span of spans) {
    result.push(span);
    if (span.children && span.children.length > 0) {
      flattenSpanTree(span.children, result);
    }
  }
  return result;
}

function buildDepthMap(spans: TraceSpan[], depth = 0, map = new Map<string, number>()): Map<string, number> {
  for (const span of spans) {
    map.set(span.id, depth);
    if (span.children && span.children.length > 0) {
      buildDepthMap(span.children, depth + 1, map);
    }
  }
  return map;
}

function formatAttributeValue(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
}
