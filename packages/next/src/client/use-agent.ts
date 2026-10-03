'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  AgentInput,
  AgentResponse,
  PendingApproval,
  ResumeDecisions,
  UseAgentOptions,
  UseAgentReturn,
} from '../types.js';
import { withRetry } from './retry.js';
import { toHttpError } from './http-error.js';

const NO_APPROVALS: PendingApproval[] = [];

export function useCogitatorAgent(options: UseAgentOptions): UseAgentReturn {
  const { api, resumeApi, headers, onError, onSuccess, retry } = options;

  const [result, setResult] = useState<AgentResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const activeRequestRef = useRef<AbortController | null>(null);
  const resultRef = useRef<AgentResponse | null>(null);

  useEffect(() => {
    return () => {
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
    };
  }, []);

  const request = useCallback(
    async (url: string, body: unknown): Promise<void> => {
      activeRequestRef.current?.abort();
      const controller = new AbortController();
      activeRequestRef.current = controller;

      setIsLoading(true);
      setError(null);

      const executeRequest = async (): Promise<AgentResponse> => {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw await toHttpError(response);
        }

        return (await response.json()) as AgentResponse;
      };

      try {
        const data = await withRetry(executeRequest, retry, controller.signal);
        if (activeRequestRef.current !== controller) return;
        resultRef.current = data;
        setResult(data);
        onSuccess?.(data);
      } catch (err) {
        if (activeRequestRef.current !== controller) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        onError?.(e);
      } finally {
        if (activeRequestRef.current === controller) {
          activeRequestRef.current = null;
          setIsLoading(false);
        }
      }
    },
    [headers, onError, onSuccess, retry]
  );

  const run = useCallback((input: AgentInput) => request(api, input), [api, request]);

  const resume = useCallback(
    async (decisions: ResumeDecisions): Promise<void> => {
      const threadId = resultRef.current?.threadId;
      if (!resumeApi || !threadId) {
        const e = new Error(
          resumeApi
            ? 'There is no result with a paused run to resume'
            : 'useCogitatorAgent needs resumeApi to resume a paused run'
        );
        setError(e);
        onError?.(e);
        return;
      }
      await request(resumeApi, { threadId, ...decisions });
    },
    [onError, request, resumeApi]
  );

  const reset = useCallback(() => {
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    resultRef.current = null;
    setResult(null);
    setError(null);
    setIsLoading(false);
  }, []);

  return {
    run,
    result,
    reasoning: result?.reasoning,
    pendingApprovals: result?.pendingApprovals ?? NO_APPROVALS,
    resume,
    isLoading,
    error,
    reset,
  };
}
