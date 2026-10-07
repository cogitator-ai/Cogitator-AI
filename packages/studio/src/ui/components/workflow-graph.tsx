import type { WorkflowInfo, WorkflowNodeRecord } from '../../protocol';

const NODE_W = 150;
const NODE_H = 44;
const GAP_X = 70;
const GAP_Y = 26;

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
  const positions = new Map<string, { x: number; y: number }>();
  for (const [column, nodes] of columns) {
    nodes.forEach((node, row) =>
      positions.set(node, { x: 20 + column * (NODE_W + GAP_X), y: 20 + row * (NODE_H + GAP_Y) })
    );
  }
  return positions;
}

/** The workflow's nodes and edges with the status of each node in a run. */
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
  const width = Math.max(...[...positions.values()].map((p) => p.x + NODE_W), 200) + 20;
  const height = Math.max(...[...positions.values()].map((p) => p.y + NODE_H), 60) + 20;
  const status = (name: string) => nodes?.find((node) => node.name === name)?.status ?? 'pending';

  return (
    <svg
      className="workflow-graph"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      data-testid="workflow-graph"
    >
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" className="edge-head" />
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
          const x2 = back ? b.x + NODE_W / 2 : b.x;
          const y2 = back ? b.y + NODE_H : b.y + NODE_H / 2;
          const mid = (x1 + x2) / 2;
          const path = back
            ? `M ${x1} ${y1} C ${x1 + 40} ${y1 + 60}, ${x2} ${y2 + 50}, ${x2} ${y2}`
            : `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
          return (
            <path
              key={`${edge.from}-${to}`}
              d={path}
              className={`edge edge-${edge.type}`}
              markerEnd="url(#arrow)"
            />
          );
        })
      )}
      {workflow.nodes.map((name) => {
        const position = positions.get(name);
        if (!position) return null;
        const current = status(name);
        return (
          <g
            key={name}
            transform={`translate(${position.x}, ${position.y})`}
            className={`node node-${current} ${selected === name ? 'node-selected' : ''}`}
            onClick={() => onSelect?.(name)}
            data-testid={`node-${name}`}
            data-status={current}
            role="button"
          >
            <rect width={NODE_W} height={NODE_H} rx="10" />
            <text x={NODE_W / 2} y={NODE_H / 2 + 1} dominantBaseline="middle" textAnchor="middle">
              {name.length > 18 ? `${name.slice(0, 17)}…` : name}
            </text>
            {current === 'running' && (
              <circle className="node-pulse" cx={NODE_W - 12} cy={12} r={4} />
            )}
          </g>
        );
      })}
    </svg>
  );
}
