import { describe, expect, it, vi } from 'vitest';
import {
  createPanelBridge,
  panelRequest,
  type PanelMessage,
  type PanelResponse,
  type PanelWindow,
} from '../plugin-bridge.js';

class FakeWindow implements PanelWindow {
  readonly posted: Array<{ message: PanelResponse; targetOrigin: string }> = [];
  postMessage(message: PanelResponse, targetOrigin: string): void {
    this.posted.push({ message, targetOrigin });
  }
}

function message(source: unknown, data: unknown, origin = 'null'): PanelMessage {
  return { source, origin, data };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('panelRequest', () => {
  const frame = new FakeWindow();

  it('reads a request of the frame with a string or numeric id', () => {
    expect(
      panelRequest(
        message(frame, { type: 'cogitator:request', id: 7, method: 'echo', params: { a: 1 } }),
        frame
      )
    ).toEqual({ id: 7, method: 'echo', params: { a: 1 } });
    expect(
      panelRequest(
        message(frame, { type: 'cogitator:request', id: 'req-1', method: 'list' }),
        frame
      )
    ).toEqual({ id: 'req-1', method: 'list' });
  });

  it('ignores messages of other windows, of a page on another origin and without a frame', () => {
    const request = { type: 'cogitator:request', id: 1, method: 'echo' };
    expect(panelRequest(message(new FakeWindow(), request), frame)).toBeUndefined();
    expect(panelRequest(message(frame, request, 'https://evil.example'), frame)).toBeUndefined();
    expect(panelRequest(message(frame, request, 'http://localhost:4321'), frame)).toBeUndefined();
    expect(panelRequest(message(undefined, request), undefined)).toBeUndefined();
    expect(panelRequest(message(null, request), null)).toBeUndefined();
  });

  it('ignores messages that are not a request with an id and a method', () => {
    for (const data of [
      'cogitator:request',
      null,
      [],
      { type: 'cogitator:response', id: 1, method: 'echo' },
      { type: 'cogitator:request', method: 'echo' },
      { type: 'cogitator:request', id: { nested: true }, method: 'echo' },
      { type: 'cogitator:request', id: Number.NaN, method: 'echo' },
      { type: 'cogitator:request', id: '', method: 'echo' },
      { type: 'cogitator:request', id: 'x'.repeat(201), method: 'echo' },
      { type: 'cogitator:request', id: 1 },
      { type: 'cogitator:request', id: 1, method: 42 },
      { type: 'cogitator:request', id: 1, method: '' },
      { type: 'cogitator:request', id: 1, method: 'm'.repeat(257) },
    ]) {
      expect(panelRequest(message(frame, data), frame)).toBeUndefined();
    }
  });
});

describe('createPanelBridge', () => {
  it('forwards a request to the handler and posts its result back to the frame', async () => {
    const frame = new FakeWindow();
    const call = vi.fn(async (method: string, params: unknown) => ({ method, params }));
    const bridge = createPanelBridge({ frame: () => frame, call });
    bridge.handle(
      message(frame, { type: 'cogitator:request', id: 3, method: 'echo', params: [1, 2] })
    );
    await flush();
    expect(call).toHaveBeenCalledWith('echo', [1, 2]);
    expect(frame.posted).toEqual([
      {
        message: {
          type: 'cogitator:response',
          id: 3,
          result: { method: 'echo', params: [1, 2] },
        },
        targetOrigin: '*',
      },
    ]);
  });

  it('posts the error of a handler that fails or throws', async () => {
    const frame = new FakeWindow();
    const bridge = createPanelBridge({
      frame: () => frame,
      call: (method) => {
        if (method === 'throws') throw new Error('thrown at once');
        return Promise.reject(new Error('the board is closed'));
      },
    });
    bridge.handle(message(frame, { type: 'cogitator:request', id: 'a', method: 'fail' }));
    bridge.handle(message(frame, { type: 'cogitator:request', id: 'b', method: 'throws' }));
    await flush();
    expect(frame.posted).toHaveLength(2);
    expect(frame.posted.map((entry) => entry.message)).toEqual(
      expect.arrayContaining([
        { type: 'cogitator:response', id: 'a', error: 'the board is closed' },
        { type: 'cogitator:response', id: 'b', error: 'thrown at once' },
      ])
    );
  });

  it('calls nothing for messages it does not answer', async () => {
    const frame = new FakeWindow();
    const call = vi.fn(async () => 'never');
    const bridge = createPanelBridge({ frame: () => frame, call });
    bridge.handle(message(new FakeWindow(), { type: 'cogitator:request', id: 1, method: 'echo' }));
    bridge.handle(message(frame, { type: 'something-else', id: 1, method: 'echo' }));
    await flush();
    expect(call).not.toHaveBeenCalled();
    expect(frame.posted).toEqual([]);
  });

  it('drops a response once it is disposed or the frame shows another page', async () => {
    let frame: FakeWindow = new FakeWindow();
    const first = frame;
    const finishers: Array<(value: unknown) => void> = [];
    const call = vi.fn(() => new Promise((resolve) => finishers.push(resolve)));
    const bridge = createPanelBridge({ frame: () => frame, call });
    bridge.handle(message(first, { type: 'cogitator:request', id: 1, method: 'slow' }));
    frame = new FakeWindow();
    finishers[0]('late');
    await flush();
    expect(first.posted).toEqual([]);
    expect(frame.posted).toEqual([]);

    bridge.handle(message(frame, { type: 'cogitator:request', id: 2, method: 'slow' }));
    bridge.dispose();
    finishers[1]('after dispose');
    bridge.handle(message(frame, { type: 'cogitator:request', id: 3, method: 'slow' }));
    await flush();
    expect(frame.posted).toEqual([]);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('closes for good when the frame loads a second document, the page navigating away', async () => {
    const frame = new FakeWindow();
    const finishers: Array<(value: unknown) => void> = [];
    const call = vi.fn(() => new Promise((resolve) => finishers.push(resolve)));
    const onNavigatedAway = vi.fn();
    const bridge = createPanelBridge({ frame: () => frame, call, onNavigatedAway });

    bridge.frameLoaded();
    expect(bridge.closed).toBe(false);
    bridge.handle(message(frame, { type: 'cogitator:request', id: 1, method: 'secret' }));
    expect(call).toHaveBeenCalledTimes(1);

    bridge.frameLoaded();
    expect(bridge.closed).toBe(true);
    expect(onNavigatedAway).toHaveBeenCalledTimes(1);

    finishers[0]('answered after the page left');
    bridge.handle(message(frame, { type: 'cogitator:request', id: 2, method: 'secret' }));
    bridge.frameLoaded();
    await flush();
    expect(frame.posted).toEqual([]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(onNavigatedAway).toHaveBeenCalledTimes(1);
  });

  it('does not report a navigation for a bridge that was disposed', () => {
    const onNavigatedAway = vi.fn();
    const bridge = createPanelBridge({
      frame: () => new FakeWindow(),
      call: async () => null,
      onNavigatedAway,
    });
    bridge.frameLoaded();
    bridge.dispose();
    bridge.frameLoaded();
    expect(bridge.closed).toBe(true);
    expect(onNavigatedAway).not.toHaveBeenCalled();
  });
});
