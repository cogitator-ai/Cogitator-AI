/**
 * Event Publisher - integrates Cogitator callbacks with Redis pub/sub
 */

import type { RunResult, Span, ToolCall, ToolResult } from '@cogitator/types';
import { publish, CHANNELS } from '../redis';

export interface RunStartEvent {
  runId: string;
  agentId: string;
  input: string;
  threadId: string;
  timestamp: number;
}

export interface RunCompleteEvent {
  runId: string;
  agentId: string;
  threadId: string;
  status: 'completed';
  output: string;
  usage: RunResult['usage'];
  toolCalls: number;
  timestamp: number;
}

export interface RunErrorEvent {
  runId: string;
  agentId: string;
  status: 'failed';
  error: string;
  timestamp: number;
}

export interface ToolCallEvent {
  runId: string;
  agentId: string;
  toolCall: ToolCall;
  timestamp: number;
}

export interface ToolResultEvent {
  runId: string;
  agentId: string;
  result: ToolResult;
  timestamp: number;
}

export interface SpanEvent {
  runId: string;
  span: Span;
  timestamp: number;
}

let currentRunContext: { runId: string; agentId: string } | null = null;

export function createCogitatorCallbacks() {
  return {
    onRunStart: async (data: { runId: string; agentId: string; input: string; threadId: string }) => {
      currentRunContext = { runId: data.runId, agentId: data.agentId };
      
      const event: RunStartEvent = {
        ...data,
        timestamp: Date.now(),
      };
      
      try {
        await publish(CHANNELS.RUN_STARTED, event);
      } catch (error) {
        console.warn('[EventPublisher] Failed to publish run start:', error);
      }
    },

    onRunComplete: async (result: RunResult) => {
      const event: RunCompleteEvent = {
        runId: result.runId,
        agentId: result.agentId,
        threadId: result.threadId,
        status: 'completed',
        output: result.output.slice(0, 500),
        usage: result.usage,
        toolCalls: result.toolCalls.length,
        timestamp: Date.now(),
      };
      
      try {
        await publish(CHANNELS.RUN_COMPLETED, event);
      } catch (error) {
        console.warn('[EventPublisher] Failed to publish run complete:', error);
      }
      
      currentRunContext = null;
    },

    onRunError: async (error: Error, runId: string) => {
      const event: RunErrorEvent = {
        runId,
        agentId: currentRunContext?.agentId ?? 'unknown',
        status: 'failed',
        error: error.message,
        timestamp: Date.now(),
      };
      
      try {
        await publish(CHANNELS.RUN_FAILED, event);
      } catch (err) {
        console.warn('[EventPublisher] Failed to publish run error:', err);
      }
      
      currentRunContext = null;
    },

    onToolCall: async (toolCall: ToolCall) => {
      if (!currentRunContext) return;
      
      const event: ToolCallEvent = {
        runId: currentRunContext.runId,
        agentId: currentRunContext.agentId,
        toolCall,
        timestamp: Date.now(),
      };
      
      try {
        await publish(CHANNELS.TOOL_CALL, event);
      } catch (error) {
        console.warn('[EventPublisher] Failed to publish tool call:', error);
      }
    },

    onToolResult: async (result: ToolResult) => {
    },

    onSpan: async (span: Span) => {
    },
  };
}

export async function publishLogEntry(entry: {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  source?: string;
  agentId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    await publish(CHANNELS.LOG_ENTRY, {
      ...entry,
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.warn('[EventPublisher] Failed to publish log entry:', error);
  }
}

export async function publishAgentStatus(agentId: string, status: 'online' | 'offline' | 'busy') {
  try {
    await publish(CHANNELS.AGENT_STATUS, {
      agentId,
      status,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.warn('[EventPublisher] Failed to publish agent status:', error);
  }
}

