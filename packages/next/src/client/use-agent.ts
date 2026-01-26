'use client';

import { useState, useCallback } from 'react';
import type { AgentInput, AgentResponse, UseAgentOptions, UseAgentReturn } from '../types.js';
import { withRetry } from './retry.js';

export function useCogitatorAgent(options: UseAgentOptions): UseAgentReturn {
  const { api, headers, onError, onSuccess, retry } = options;

  const [result, setResult] = useState<AgentResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(
    async (input: AgentInput): Promise<void> => {
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
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          throw new Error(`Request failed: ${response.status} - ${errorText}`);
        }

        return response.json() as Promise<AgentResponse>;
      };

      try {
        const data = await withRetry(executeRequest, retry);
        setResult(data);
        onSuccess?.(data);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        onError?.(e);
      } finally {
        setIsLoading(false);
      }
    },
    [api, headers, onError, onSuccess, retry]
  );

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return {
    run,
    result,
    isLoading,
    error,
    reset,
  };
}
