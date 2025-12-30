'use client';

import { memo } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import {
  Bot,
  Wrench,
  Code,
  User,
  Clock,
  Play,
  CheckCircle,
  GitBranch,
} from 'lucide-react';

interface WorkflowNodeData {
  label: string;
  nodeType: string;
  config: Record<string, unknown>;
  status?: 'pending' | 'running' | 'completed' | 'failed';
}

const nodeConfig = {
  start: { icon: Play, color: '#22c55e', bgColor: 'bg-success/10' },
  end: { icon: CheckCircle, color: '#22c55e', bgColor: 'bg-success/10' },
  agent: { icon: Bot, color: '#3b82f6', bgColor: 'bg-blue-500/10' },
  tool: { icon: Wrench, color: '#10b981', bgColor: 'bg-emerald-500/10' },
  function: { icon: Code, color: '#8b5cf6', bgColor: 'bg-purple-500/10' },
  human: { icon: User, color: '#f59e0b', bgColor: 'bg-amber-500/10' },
  delay: { icon: Clock, color: '#6b7280', bgColor: 'bg-gray-500/10' },
  subworkflow: { icon: GitBranch, color: '#ec4899', bgColor: 'bg-pink-500/10' },
};

function WorkflowNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as WorkflowNodeData;
  const config = nodeConfig[nodeData.nodeType as keyof typeof nodeConfig] || nodeConfig.agent;
  const Icon = config.icon;

  const isStartOrEnd = nodeData.nodeType === 'start' || nodeData.nodeType === 'end';

  return (
    <div
      className={`
        px-4 py-3 rounded-xl border-2 transition-all min-w-[150px]
        ${config.bgColor}
        ${selected ? 'border-accent shadow-lg shadow-accent/20' : 'border-border-primary'}
        ${nodeData.status === 'running' ? 'animate-pulse' : ''}
      `}
    >
      {/* Input Handle */}
      {nodeData.nodeType !== 'start' && (
        <Handle
          type="target"
          position={Position.Top}
          className="!bg-accent !border-accent !w-3 !h-3"
        />
      )}

      <div className="flex items-center gap-3">
        <div
          className="p-2 rounded-lg"
          style={{ backgroundColor: `${config.color}20` }}
        >
          <Icon className="w-5 h-5" style={{ color: config.color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-text-primary truncate">
            {nodeData.label}
          </div>
          {!isStartOrEnd && nodeData.config && Object.keys(nodeData.config).length > 0 && (
            <div className="text-xs text-text-muted truncate">
              {Object.keys(nodeData.config).length} settings
            </div>
          )}
        </div>
        {nodeData.status && (
          <div
            className={`w-2 h-2 rounded-full ${
              nodeData.status === 'completed'
                ? 'bg-success'
                : nodeData.status === 'running'
                  ? 'bg-warning animate-pulse'
                  : nodeData.status === 'failed'
                    ? 'bg-error'
                    : 'bg-text-muted'
            }`}
          />
        )}
      </div>

      {/* Output Handle */}
      {nodeData.nodeType !== 'end' && (
        <Handle
          type="source"
          position={Position.Bottom}
          className="!bg-accent !border-accent !w-3 !h-3"
        />
      )}
    </div>
  );
}

export const WorkflowNode = memo(WorkflowNodeComponent);

