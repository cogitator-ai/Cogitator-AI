import type { WorkflowInfo, WorkflowNodeRecord } from '../../protocol';
import { formatDuration } from '../format';

const NODE_W = 184;
const NODE_H = 56;
const GAP_X = 72;
const GAP_Y = 28;

const STATUS_TEXT: Record<WorkflowNodeRecord['status'], string> = {
  pending: 'pending',
  running: 'running',
  completed: 'done',
  failed: 'failed',
  skipped: 'skipped',
};

/** Columns of a workflow: each node one column after the latest node that leads to it. */
function layout(workflow: WorkflowInfo): Map<string, { x: number; y: number }> {
  const level = new Map<string, number>([[workflow.entryPoint, 0]]);
  for (const _pass of workflow.nodes) {
    for (const edge of workflow.edges) {
      const from = level.get(edge.from);
      if (from === undefined) continue;
      for (const to of edge.to) {
        if (to === edge.from) continue;
        if ((level.get(to) ?? -1) < from + 1 && from + 1 < workflow.nodes.length)
          level.set(to, from + 1);
      }
    }
  }
  for (const node of workflow.nodes) if (!level.has(node)) level.set(node, 0);
  const columns = new Map<number, string[]>();
  for (const node of workflow.nodes) {
    const column = level.get(node) ?? 0;
    columns.set(column, [...(columns.get(column) ?? []), node]);
  }
  const tallest = Math.max(...[...columns.values()].map((nodes) => nodes.length), 1);
  const positions = new Map<string, { x: number; y: number }>();
  for (const [column, nodes] of columns) {
    const offset = ((tallest - nodes.length) * (NODE_H + GAP_Y)) / 2;
    nodes.forEach((node, row) =>
      positions.set(node, {
        x: column * (NODE_W + GAP_X),
        y: offset + row * (NODE_H + GAP_Y),
      })
    );
  }
  return positions;
}

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/** The workflow's nodes and edges with the status and time of each node in a run. */
export function WorkflowGraph({
  workflow,
  nodes,
  selected,
  onSelect,
}: {
  workflow: WorkflowInfo;
  nodes?: WorkflowNodeRecord[];
  selected?: string;
  onSelect?: (node: string) => void;
}) {
  const positions = layout(workflow);
  const width = Math.max(...[...positions.values()].map((p) => p.x + NODE_W), NODE_W);
  const height = Math.max(...[...positions.values()].map((p) => p.y + NODE_H), NODE_H) + 30;
  const record = (name: string) => nodes?.find((node) => node.name === name);
  const status = (name: string) => record(name)?.status ?? 'pending';

  return (
    <svg
      className="workflow-graph"
      viewBox={`-2 -2 ${width + 4} ${height + 4}`}
      width={width + 4}
      height={height + 4}
      role="group"
      aria-label={`Graph of ${workflow.name}`}
      data-testid="workflow-graph"
    >
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 9 5 L 0 9 z" className="edge-head" />
        </marker>
      </defs>
      {workflow.edges.flatMap((edge) =>
        edge.to.map((to) => {
          const a = positions.get(edge.from);
          const b = positions.get(to);
          if (!a || !b) return null;
          const back = b.x <= a.x;
          const x1 = a.x + NODE_W;
          const y1 = a.y + NODE_H / 2;
          const x2 = back ? b.x + NODE_W / 2 : b.x - 2;
          const y2 = back ? b.y + NODE_H : b.y + NODE_H / 2;
          const mid = (x1 + x2) / 2;
          const path = back
            ? `M ${x1} ${y1} C ${x1 + 48} ${y1 + 70}, ${x2} ${y2 + 56}, ${x2} ${y2 + 2}`
            : `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
          const fromStatus = status(edge.from);
          const toStatus = status(to);
          const state =
            fromStatus === 'completed' && toStatus === 'running'
              ? 'edge-live'
              : fromStatus === 'completed' && toStatus === 'completed'
                ? 'edge-done'
                : '';
          return (
            <path
              key={`${edge.from}-${to}`}
              d={path}
              className={`edge edge-${edge.type} ${state}`}
              markerEnd="url(#arrow)"
            />
          );
        })
      )}
      {workflow.nodes.map((name) => {
        const position = positions.get(name);
        if (!position) return null;
        const node = record(name);
        const current = node?.status ?? 'pending';
        const sub =
          node?.duration !== undefined
            ? `${STATUS_TEXT[current]} · ${formatDuration(node.duration)}`
            : STATUS_TEXT[current];
        return (
          <g
            key={name}
            transform={`translate(${position.x}, ${position.y})`}
            className={`node node-${current} ${selected === name ? 'node-selected' : ''}`}
            onClick={() => onSelect?.(name)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect?.(name);
              }
            }}
            data-testid={`node-${name}`}
            data-status={current}
            role="button"
            tabIndex={onSelect ? 0 : -1}
            aria-pressed={selected === name}
            aria-label={`${name}, ${sub}`}
          >
            <title>{name}</title>
            <rect className="node-card" width={NODE_W} height={NODE_H} rx="10" />
            <circle className="node-dot" cx={18} cy={NODE_H / 2} r={4} />
            <text className="node-name" x={32} y={23}>
              {truncate(name, 20)}
            </text>
            <text className="node-sub" x={32} y={40}>
              {sub}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
