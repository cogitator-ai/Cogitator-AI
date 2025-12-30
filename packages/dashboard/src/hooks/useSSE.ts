'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

interface SSEOptions {
  onMessage?: (event: string, data: unknown) => void;
  onError?: (error: Event) => void;
  onOpen?: () => void;
  reconnectInterval?: number;
  maxRetries?: number;
}

export function useSSE(url: string, options: SSEOptions = {}) {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const retriesRef = useRef(0);
  const {
    onMessage,
    onError,
    onOpen,
    reconnectInterval = 5000,
    maxRetries = 10,
  } = options;

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setConnected(true);
      setError(null);
      retriesRef.current = 0;
      onOpen?.();
    };

    eventSource.onerror = (event) => {
      setConnected(false);
      setError('Connection lost');
      onError?.(event);
      
      eventSource.close();
      eventSourceRef.current = null;

      if (retriesRef.current < maxRetries) {
        retriesRef.current += 1;
        setTimeout(connect, reconnectInterval);
      }
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onMessage?.('message', data);
      } catch {
        onMessage?.('message', event.data);
      }
    };

    const events = ['started', 'completed', 'failed', 'entry', 'status', 'heartbeat', 'connected'];
    events.forEach((eventName) => {
      eventSource.addEventListener(eventName, (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          onMessage?.(eventName, data);
        } catch {
          onMessage?.(eventName, event.data);
        }
      });
    });
  }, [url, onMessage, onError, onOpen, reconnectInterval, maxRetries]);

  useEffect(() => {
    connect();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [connect]);

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
      setConnected(false);
    }
  }, []);

  return { connected, error, disconnect, reconnect: connect };
}

