'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { Header } from '@/components/layout/Header';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  ReactFlow,
  Node,
  Edge,
  Controls,
  Background,
  addEdge,
  Connection,
  useNodesState,
  useEdgesState,
  MarkerType,
  Panel,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Plus,
  Save,
  Play,
  GitBranch,
  Bot,
  Wrench,
  Code,
  User,
  Clock,
  Search,
  Trash2,
  Settings,
} from 'lucide-react';
import { WorkflowNode } from '@/components/workflows/WorkflowNode';
import { CreateWorkflowModal } from '@/components/workflows/CreateWorkflowModal';
import { NodeConfigModal } from '@/components/workflows/NodeConfigModal';

interface Workflow {
  id: string;
  name: string;
  description?: string;
  definition: unknown;
  totalRuns: number;
  lastRunAt?: string;
  createdAt: string;
}

const nodeTypes = {
  workflow: WorkflowNode,
};

const NODE_TYPES = [
  { type: 'agent', label: 'Agent', icon: Bot, color: '#3b82f6' },
  { type: 'tool', label: 'Tool', icon: Wrench, color: '#10b981' },
  { type: 'function', label: 'Function', icon: Code, color: '#8b5cf6' },
  { type: 'human', label: 'Human', icon: User, color: '#f59e0b' },
  { type: 'delay', label: 'Delay', icon: Clock, color: '#6b7280' },
];

const initialNodes: Node[] = [
  {
    id: 'start',
    type: 'workflow',
    position: { x: 250, y: 50 },
    data: { label: 'Start', nodeType: 'start', config: {} },
  },
  {
    id: 'end',
    type: 'workflow',
    position: { x: 250, y: 400 },
    data: { label: 'End', nodeType: 'end', config: {} },
  },
];

const initialEdges: Edge[] = [];

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showNodeConfig, setShowNodeConfig] = useState(false);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [saving, setSaving] = useState(false);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    fetchWorkflows();
  }, []);

  const fetchWorkflows = async () => {
    try {
      const response = await fetch('/api/workflows');
      if (response.ok) {
        const data = await response.json();
        setWorkflows(data.workflows || []);
      }
    } catch (error) {
      console.error('Failed to fetch workflows:', error);
    } finally {
      setLoading(false);
    }
  };

  const onConnect = useCallback(
    (params: Connection) => {
      setEdges((eds) =>
        addEdge(
          {
            ...params,
            type: 'smoothstep',
            animated: true,
            markerEnd: { type: MarkerType.ArrowClosed },
          },
          eds
        )
      );
    },
    [setEdges]
  );

  const onNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.data.nodeType !== 'start' && node.data.nodeType !== 'end') {
        setSelectedNode(node);
        setShowNodeConfig(true);
      }
    },
    []
  );

  const addNode = (type: string) => {
    const nodeConfig = NODE_TYPES.find((n) => n.type === type);
    if (!nodeConfig) return;

    const newNode: Node = {
      id: `node_${Date.now()}`,
      type: 'workflow',
      position: { x: 250 + Math.random() * 100, y: 200 + Math.random() * 100 },
      data: {
        label: `${nodeConfig.label} ${nodes.length - 1}`,
        nodeType: type,
        config: {},
      },
    };

    setNodes((nds) => [...nds, newNode]);
  };

  const deleteNode = (nodeId: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== nodeId));
    setEdges((eds) =>
      eds.filter((e) => e.source !== nodeId && e.target !== nodeId)
    );
  };

  const updateNodeConfig = (nodeId: string, config: Record<string, unknown>) => {
    setNodes((nds) =>
      nds.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, config } } : n
      )
    );
    setShowNodeConfig(false);
    setSelectedNode(null);
  };

  const loadWorkflow = (workflow: Workflow) => {
    setSelectedWorkflow(workflow);
    const def = workflow.definition as {
      nodes?: Node[];
      edges?: Edge[];
    };
    if (def.nodes) setNodes(def.nodes);
    if (def.edges) setEdges(def.edges);
  };

  const saveWorkflow = async () => {
    if (!selectedWorkflow) return;

    setSaving(true);
    try {
      const response = await fetch(`/api/workflows/${selectedWorkflow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition: { nodes, edges },
        }),
      });

      if (response.ok) {
        fetchWorkflows();
      }
    } catch (error) {
      console.error('Failed to save workflow:', error);
    } finally {
      setSaving(false);
    }
  };

  const runWorkflow = async () => {
    if (!selectedWorkflow) return;

    try {
      const response = await fetch(`/api/workflows/${selectedWorkflow.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: {} }),
      });

      if (response.ok) {
        const run = await response.json();
        console.log('Workflow started:', run);
      }
    } catch (error) {
      console.error('Failed to run workflow:', error);
    }
  };

  const filteredWorkflows = workflows.filter((w) =>
    w.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 flex overflow-hidden">
          {/* Workflows List Sidebar */}
          <div className="w-72 border-r border-border-subtle bg-bg-secondary flex flex-col">
            <div className="p-4 border-b border-border-subtle">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-text-primary">
                  Workflows
                </h2>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setShowCreateModal(true)}
                >
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
              <Input
                placeholder="Search workflows..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                icon={<Search className="w-4 h-4" />}
              />
            </div>

            <div className="flex-1 overflow-auto p-2 space-y-2">
              {loading ? (
                <>
                  <Skeleton className="h-16" />
                  <Skeleton className="h-16" />
                  <Skeleton className="h-16" />
                </>
              ) : filteredWorkflows.length === 0 ? (
                <div className="text-center py-8 text-text-muted">
                  <GitBranch className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No workflows yet</p>
                </div>
              ) : (
                filteredWorkflows.map((workflow) => (
                  <button
                    key={workflow.id}
                    onClick={() => loadWorkflow(workflow)}
                    className={`w-full p-3 rounded-lg text-left transition-colors ${
                      selectedWorkflow?.id === workflow.id
                        ? 'bg-accent/10 border border-accent'
                        : 'bg-bg-tertiary hover:bg-bg-hover border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <GitBranch className="w-4 h-4 text-accent" />
                      <span className="font-medium text-text-primary truncate">
                        {workflow.name}
                      </span>
                    </div>
                    {workflow.description && (
                      <p className="text-xs text-text-muted mt-1 truncate">
                        {workflow.description}
                      </p>
                    )}
                    <div className="flex items-center gap-2 mt-2 text-xs text-text-muted">
                      <span>{workflow.totalRuns} runs</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Workflow Builder */}
          <div className="flex-1 flex flex-col">
            {/* Toolbar */}
            <div className="h-14 border-b border-border-subtle bg-bg-secondary flex items-center justify-between px-4">
              <div className="flex items-center gap-2">
                {NODE_TYPES.map((nodeType) => (
                  <Button
                    key={nodeType.type}
                    variant="ghost"
                    size="sm"
                    onClick={() => addNode(nodeType.type)}
                    className="gap-1"
                  >
                    <nodeType.icon
                      className="w-4 h-4"
                      style={{ color: nodeType.color }}
                    />
                    {nodeType.label}
                  </Button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                {selectedWorkflow && (
                  <>
                    <Badge variant="outline">{selectedWorkflow.name}</Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={saveWorkflow}
                      disabled={saving}
                    >
                      <Save className="w-4 h-4" />
                      {saving ? 'Saving...' : 'Save'}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={runWorkflow}
                    >
                      <Play className="w-4 h-4" />
                      Run
                    </Button>
                  </>
                )}
              </div>
            </div>

            {/* Canvas */}
            <div className="flex-1">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeDoubleClick={onNodeDoubleClick}
                nodeTypes={nodeTypes}
                fitView
                deleteKeyCode={['Backspace', 'Delete']}
                className="bg-bg-primary"
              >
                <Background color="#333" gap={20} />
                <Controls className="bg-bg-secondary border-border-subtle" />
                <Panel position="bottom-center" className="mb-4">
                  <Card className="px-4 py-2">
                    <p className="text-xs text-text-muted">
                      Double-click node to configure • Drag to connect •
                      Backspace to delete
                    </p>
                  </Card>
                </Panel>
              </ReactFlow>
            </div>
          </div>
        </main>
      </div>

      <CreateWorkflowModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={(workflow) => {
          fetchWorkflows();
          loadWorkflow(workflow);
        }}
      />

      {selectedNode && (
        <NodeConfigModal
          isOpen={showNodeConfig}
          onClose={() => {
            setShowNodeConfig(false);
            setSelectedNode(null);
          }}
          node={selectedNode}
          onSave={updateNodeConfig}
          onDelete={() => {
            deleteNode(selectedNode.id);
            setShowNodeConfig(false);
            setSelectedNode(null);
          }}
        />
      )}
    </div>
  );
}
