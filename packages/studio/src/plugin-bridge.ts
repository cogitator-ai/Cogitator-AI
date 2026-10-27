/**
 * The bridge between a plugin panel's page, shown in a sandboxed frame, and the plugin's
 * handlers. The page asks with `window.parent.postMessage({ type: 'cogitator:request', id,
 * method, params }, '*')` and gets `{ type: 'cogitator:response', id, result }` or `{ type:
 * 'cogitator:response', id, error }` back. The file uses no DOM types, so the UI and the tests
 * share it.
 */

/** A request of a panel's page: `method` names one of the panel's handlers. */
export interface PanelRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

/** What the bridge posts back to the page for a request. */
export type PanelResponse =
  | { type: 'cogitator:response'; id: string | number; result: unknown }
  | { type: 'cogitator:response'; id: string | number; error: string };

/** A `message` event as the bridge reads it. */
export interface PanelMessage {
  /** The window that posted it. */
  source: unknown;
  /** The origin of that window: `null` for a sandboxed page without `allow-same-origin`. */
  origin: string;
  data: unknown;
}

/** The window of a panel's frame, as the bridge posts to it. */
export interface PanelWindow {
  postMessage(message: PanelResponse, targetOrigin: string): void;
}

/** The origin a frame sandboxed without `allow-same-origin` posts from. */
export const OPAQUE_ORIGIN = 'null';
const MAX_ID_LENGTH = 200;
const MAX_METHOD_LENGTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string | number {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

/**
 * The request a message carries, or undefined when the bridge does not answer it: it did not come
 * from `frame` (another window, the studio itself, a page the frame navigated to on another
 * origin), or it is not a `cogitator:request` with a numeric or string id and a method name.
 */
export function panelRequest(message: PanelMessage, frame: unknown): PanelRequest | undefined {
  if (frame === null || frame === undefined || message.source !== frame) return undefined;
  if (message.origin !== OPAQUE_ORIGIN) return undefined;
  const { data } = message;
  if (!isRecord(data) || data.type !== 'cogitator:request') return undefined;
  if (!isRequestId(data.id)) return undefined;
  const { method } = data;
  if (typeof method !== 'string' || method.length === 0 || method.length > MAX_METHOD_LENGTH) {
    return undefined;
  }
  return { id: data.id, method, ...(data.params !== undefined && { params: data.params }) };
}

export interface PanelBridgeOptions {
  /** The window of the panel's frame now, missing while there is none. */
  frame: () => PanelWindow | null | undefined;
  /** Calls the panel's handler `method` with `params`: what it resolves with is the result. */
  call: (method: string, params: unknown) => Promise<unknown>;
  /** Hears, once, that the bridge closed because the frame navigated away from the panel's page. */
  onNavigatedAway?: () => void;
}

export interface PanelBridge {
  /** Answers a `message` event of the studio's window, when it is a request of the panel. */
  handle(message: PanelMessage): void;
  /**
   * The frame finished loading a document. The first load is the panel's page. The sandbox does
   * not keep a page from navigating its own frame, to any address, so every later load means the
   * page left it: the bridge closes for good, answers nothing more and calls `onNavigatedAway`.
   */
  frameLoaded(): void;
  /** Whether it stopped answering, disposed or closed by a navigation. */
  readonly closed: boolean;
  /** Stops answering: calls still going are not posted back. */
  dispose(): void;
}

/**
 * Answers the requests of one panel's page, in one frame. Each request is forwarded to `call`, and
 * its result or error is posted to the frame it came from, as long as the frame still shows that
 * page: a response is dropped once the bridge is closed or the frame got a new window. A sandboxed
 * page has an opaque origin, so responses are posted to `*`, but only to that frame's window. A
 * frame that loads a second document closes the bridge, see `frameLoaded`.
 */
export function createPanelBridge(options: PanelBridgeOptions): PanelBridge {
  let closed = false;
  let loads = 0;
  return {
    get closed() {
      return closed;
    },
    handle(message) {
      if (closed) return;
      const target = options.frame();
      const request = panelRequest(message, target);
      if (!request || !target) return;
      const reply = (response: PanelResponse) => {
        if (closed || options.frame() !== target) return;
        target.postMessage(response, '*');
      };
      const pending = (async () => options.call(request.method, request.params))();
      void pending.then(
        (result) => reply({ type: 'cogitator:response', id: request.id, result }),
        (error: unknown) =>
          reply({
            type: 'cogitator:response',
            id: request.id,
            error: error instanceof Error ? error.message : String(error),
          })
      );
    },
    frameLoaded() {
      loads++;
      if (loads === 1 || closed) return;
      closed = true;
      options.onNavigatedAway?.();
    },
    dispose() {
      closed = true;
    },
  };
}
