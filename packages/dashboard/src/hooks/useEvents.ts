import { useState, useEffect, useCallback, useRef } from 'react';

type EventHandler = (data: unknown) => void;

interface UseEventsOptions {
  autoConnect?: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
}

interface EventState {
  connected: boolean;
  error: Error | null;
}

export function useEvents(options: UseEventsOptions = {}) {
  const { autoConnect = true, onConnect, onDisconnect, onError } = options;
  const [state, setState] = useState<EventState>({ connected: false, error: null });
  const eventSourceRef = useRef<EventSource | null>(null);
  const handlersRef = useRef<Map<string, Set<EventHandler>>>(new Map());
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);

  const connect = useCallback(() => {
    if (eventSourceRef.current?.readyState === EventSource.OPEN) {
      return;
    }

    try {
      const eventSource = new EventSource('/api/events');
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        setState({ connected: true, error: null });
        reconnectAttemptsRef.current = 0;
        onConnect?.();
      };

      eventSource.onerror = () => {
        setState((prev) => ({ ...prev, connected: false }));
        onDisconnect?.();

        // Reconnect with exponential backoff
        if (reconnectAttemptsRef.current < 5) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
          reconnectAttemptsRef.current++;
          reconnectTimeoutRef.current = setTimeout(connect, delay);
        } else {
          const error = new Error('Failed to connect to event stream');
          setState({ connected: false, error });
          onError?.(error);
        }
      };

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const handlers = handlersRef.current.get('message');
          handlers?.forEach((handler) => handler(data));
        } catch (e) {
          console.error('Failed to parse event data:', e);
        }
      };

      // Handle custom events
      eventSource.addEventListener('connected', (event) => {
        const data = JSON.parse((event as MessageEvent).data);
        const handlers = handlersRef.current.get('connected');
        handlers?.forEach((handler) => handler(data));
      });

      eventSource.addEventListener('run', (event) => {
        const data = JSON.parse((event as MessageEvent).data);
        const handlers = handlersRef.current.get('run');
        handlers?.forEach((handler) => handler(data));
      });

      eventSource.addEventListener('log', (event) => {
        const data = JSON.parse((event as MessageEvent).data);
        const handlers = handlersRef.current.get('log');
        handlers?.forEach((handler) => handler(data));
      });

      eventSource.addEventListener('agent', (event) => {
        const data = JSON.parse((event as MessageEvent).data);
        const handlers = handlersRef.current.get('agent');
        handlers?.forEach((handler) => handler(data));
      });

      eventSource.addEventListener('workflow', (event) => {
        const data = JSON.parse((event as MessageEvent).data);
        const handlers = handlersRef.current.get('workflow');
        handlers?.forEach((handler) => handler(data));
      });

      eventSource.addEventListener('swarm', (event) => {
        const data = JSON.parse((event as MessageEvent).data);
        const handlers = handlersRef.current.get('swarm');
        handlers?.forEach((handler) => handler(data));
      });
    } catch (e) {
      const error = e instanceof Error ? e : new Error('Failed to create EventSource');
      setState({ connected: false, error });
      onError?.(error);
    }
  }, [onConnect, onDisconnect, onError]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    reconnectAttemptsRef.current = 5; // Prevent auto-reconnect
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setState({ connected: false, error: null });
  }, []);

  const subscribe = useCallback((event: string, handler: EventHandler): (() => void) => {
    if (!handlersRef.current.has(event)) {
      handlersRef.current.set(event, new Set());
    }
    handlersRef.current.get(event)!.add(handler);

    return () => {
      handlersRef.current.get(event)?.delete(handler);
    };
  }, []);

  useEffect(() => {
    if (autoConnect) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [autoConnect, connect, disconnect]);

  return {
    ...state,
    connect,
    disconnect,
    subscribe,
  };
}

export function useRunEvents(
  runId: string | null,
  options: {
    onToken?: (token: string) => void;
    onToolCall?: (toolCall: { id: string; name: string; arguments: unknown }) => void;
    onToolResult?: (result: { callId: string; result: unknown; error?: string }) => void;
    onComplete?: (data: { output: string; usage: unknown }) => void;
    onError?: (error: string) => void;
  }
) {
  const { subscribe, connected } = useEvents();

  useEffect(() => {
    if (!runId) return;

    const unsubscribe = subscribe('run', (data: unknown) => {
      const event = data as {
        runId: string;
        type: 'token' | 'toolCall' | 'toolResult' | 'complete' | 'error';
        payload: unknown;
      };

      if (event.runId !== runId) return;

      switch (event.type) {
        case 'token':
          options.onToken?.(event.payload as string);
          break;
        case 'toolCall':
          options.onToolCall?.(
            event.payload as { id: string; name: string; arguments: unknown }
          );
          break;
        case 'toolResult':
          options.onToolResult?.(
            event.payload as { callId: string; result: unknown; error?: string }
          );
          break;
        case 'complete':
          options.onComplete?.(event.payload as { output: string; usage: unknown });
          break;
        case 'error':
          options.onError?.(event.payload as string);
          break;
      }
    });

    return unsubscribe;
  }, [runId, subscribe, options]);

  return { connected };
}

