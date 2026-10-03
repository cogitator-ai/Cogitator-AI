import type { ReactNode } from 'react';

export type RouteMethod = 'GET' | 'POST' | 'DELETE' | 'WS' | 'HOOK' | 'FN';

/** One thing an integration gives you: an HTTP route, a socket, a hook or a function. */
export interface RouteItem {
  method: RouteMethod;
  path: string;
  label: string;
  /** What turns it on, when the snippet does not. */
  optIn?: string;
}

export type StreamTone = 'meta' | 'tool' | 'text';

export interface StreamLine {
  label: string;
  value?: string;
  tone: StreamTone;
  /** Text this event adds to the streamed answer. */
  delta?: string;
}

/** A replay of one request and the events it streams back. */
export interface StreamScript {
  request: { method: string; target: string; body?: string };
  /** Status line of the response, e.g. `200 · text/event-stream`. */
  response: string;
  /** How one event looks on the wire. */
  wire: string;
  events: StreamLine[];
}

export interface RuntimeFile {
  name: string;
  code: ReactNode;
}

export interface RuntimeTab {
  id: string;
  label: string;
  icon: ReactNode;
  runtime: string;
  install: string;
  files: RuntimeFile[];
  routes: RouteItem[];
  stream: StreamScript;
  example: string;
  docsHref: string;
}
