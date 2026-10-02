'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import type { AgentInput, AgentResponse, UseAgentOptions, UseAgentReturn } from '../types.js';
import { withRetry } from './retry.js';
import { toHttpError } from './http-error.js';

export function useCogitatorAgent(options: UseAgentOptions): UseAgentReturn {
  const { api, headers, onError, onSuccess, retry } = options;

  const [result, setResult] = useState<AgentResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const activeRequestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
    };
  }, []);

  const run = useCallback(
    async (input: AgentInput): Promise<void> => {
      activeRequestRef.current?.abort();
      const controller = new AbortController();
      activeRequestRef.current = controller;

      setIsLoading(true);
      setError(null);

      const executeRequest = async (): Promise<AgentResponse> => {
        const response = await fetch(api, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          body: JSON.stringify(input),
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
    [api, headers, onError, onSuccess, retry]
  );

  const reset = useCallback(() => {
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    setResult(null);
    setError(null);
    setIsLoading(false);
  }, []);

  return {
    run,
    result,
    isLoading,
    error,
    reset,
  };
}
