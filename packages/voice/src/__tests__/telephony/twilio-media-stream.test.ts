import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  TwilioMediaStream,
  type TwilioMediaStreamOptions,
} from '../../telephony/twilio-media-stream';
import { float32ToPcm16, pcm16ToFloat32 } from '../../audio';

type Sent = Record<string, unknown> & { event: string };

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: Sent[] = [];
  closed: { code?: number; reason?: string } | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Sent);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code ?? 1005, Buffer.from(reason ?? ''));
  }

  ping(): void {}

  terminate(): void {
    this.close(1006);
  }

  receive(message: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(message)), false);
  }
}

const STREAM_SID = 'MZ0001';

function startEvent(customParameters: Record<string, string> = {}, sampleRate: unknown = 8000) {
  return {
    event: 'start',
    sequenceNumber: '1',
    streamSid: STREAM_SID,
    start: {
      accountSid: 'AC0001',
      streamSid: STREAM_SID,
      callSid: 'CA0001',
      tracks: ['inbound'],
      customParameters,
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate, channels: 1 },
    },
  };
}

function media(payload: Buffer, track = 'inbound', streamSid = STREAM_SID) {
  return {
    event: 'media',
    sequenceNumber: '3',
    streamSid,
    media: { track, chunk: '1', timestamp: '20', payload: payload.toString('base64') },
  };
}

function setup(options: TwilioMediaStreamOptions = {}) {
  const socket = new FakeSocket();
  const stream = new TwilioMediaStream(socket as unknown as WebSocket, options);
  const errors: Error[] = [];
  stream.on('error', (err) => errors.push(err));
  return { socket, stream, errors };
}

async function started(options: TwilioMediaStreamOptions = {}) {
  const context = setup(options);
  context.socket.receive({ event: 'connected', protocol: 'Call', version: '1.0.0' });
  context.socket.receive(startEvent());
  await vi.waitFor(() => expect(context.stream.start).not.toBeNull());
  return context;
}

function payloads(sent: Sent[]): Buffer[] {
  return sent
    .filter((m) => m.event === 'media')
    .map((m) => Buffer.from((m.media as { payload: string }).payload, 'base64'));
}

describe('TwilioMediaStream', () => {
  describe('inbound events', () => {
    it('reads the start event, numbers sent as strings included', async () => {
      const { socket, stream } = setup();
      const starts: unknown[] = [];
      stream.on('start', (start) => starts.push(start));
      socket.receive(startEvent({ caller: '+15550001' }, '8000'));
      await vi.waitFor(() => expect(starts).toHaveLength(1));
      expect(starts[0]).toEqual({
        accountSid: 'AC0001',
        streamSid: STREAM_SID,
        callSid: 'CA0001',
        tracks: ['inbound'],
        customParameters: { caller: '+15550001' },
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      });
      expect(stream.streamSid).toBe(STREAM_SID);
      expect(stream.callSid).toBe('CA0001');
    });

    it('emits inbound audio after the start, and drops other tracks and streams', async () => {
      const { socket, stream } = setup();
      const audio: Buffer[] = [];
      stream.on('audio', (chunk) => audio.push(chunk));
      socket.receive(media(Buffer.from([1, 2])));
      socket.receive(startEvent());
      await vi.waitFor(() => expect(stream.start).not.toBeNull());
      socket.receive(media(Buffer.from([3, 4])));
      socket.receive(media(Buffer.from([5]), 'outbound'));
      socket.receive(media(Buffer.from([6]), 'inbound', 'MZ-other'));
      expect(audio).toEqual([Buffer.from([3, 4])]);
    });

    it('decodes inbound audio to the requested format', async () => {
      const { socket, stream } = await started({
        inbound: { encoding: 'pcm16', sampleRate: 16000 },
      });
      const audio: Buffer[] = [];
      stream.on('audio', (chunk) => audio.push(chunk));
      socket.receive(media(Buffer.alloc(800, 0xff)));
      const samples = pcm16ToFloat32(Buffer.concat(audio));
      expect(samples.length).toBeGreaterThan(1000);
      expect(samples.every((s) => s === 0)).toBe(true);
    });

    it('reports key presses', async () => {
      const { socket, stream } = await started();
      const digits: string[] = [];
      stream.on('dtmf', (digit) => digits.push(digit));
      socket.receive({
        event: 'dtmf',
        streamSid: STREAM_SID,
        sequenceNumber: '5',
        dtmf: { track: 'inbound_track', digit: '7' },
      });
      expect(digits).toEqual(['7']);
    });

    it('reports malformed JSON and events, and ignores unknown events', async () => {
      const { socket, errors } = await started();
      socket.emit('message', Buffer.from('{oops'), false);
      socket.receive({ event: 'media', streamSid: STREAM_SID, media: {} });
      socket.receive({ event: 'something-new', streamSid: STREAM_SID });
      expect(errors.map((e) => e.message)).toEqual([
        expect.stringContaining('Invalid JSON'),
        expect.stringContaining('Malformed Twilio media event'),
      ]);
    });

    it('refuses a media format other than μ-law at 8 kHz', () => {
      const { socket, stream, errors } = setup();
      const event = startEvent();
      event.start.mediaFormat.encoding = 'audio/x-l16';
      socket.receive(event);
      expect(socket.closed?.code).toBe(1003);
      expect(stream.start).toBeNull();
      expect(errors[0]?.message).toContain('Unsupported Twilio media format');
    });
  });

  describe('authorization', () => {
    it('closes a refused stream with 1008 and never starts it', async () => {
      const authorize = vi.fn().mockResolvedValue(false);
      const { socket, stream } = setup({ authorize });
      const starts = vi.fn();
      stream.on('start', starts);
      socket.receive(startEvent({ token: 'bad' }));
      await vi.waitFor(() => expect(socket.closed?.code).toBe(1008));
      expect(authorize).toHaveBeenCalledWith(
        expect.objectContaining({ customParameters: { token: 'bad' } })
      );
      expect(starts).not.toHaveBeenCalled();
    });

    it('closes the stream when the check throws', async () => {
      const { socket, errors } = setup({
        authorize: () => {
          throw new Error('store down');
        },
      });
      socket.receive(startEvent());
      await vi.waitFor(() => expect(socket.closed?.code).toBe(1008));
      expect(errors.map((e) => e.message)).toContain('store down');
    });

    it('drops audio that arrives before the answer', async () => {
      let allow!: (value: boolean) => void;
      const { socket, stream } = setup({
        authorize: () => new Promise<boolean>((resolve) => (allow = resolve)),
      });
      const audio: Buffer[] = [];
      stream.on('audio', (chunk) => audio.push(chunk));
      socket.receive(startEvent());
      socket.receive(media(Buffer.from([1])));
      allow(true);
      await vi.waitFor(() => expect(stream.start).not.toBeNull());
      socket.receive(media(Buffer.from([2])));
      expect(audio).toEqual([Buffer.from([2])]);
    });

    it('refuses a second start', async () => {
      const { socket, errors } = await started();
      socket.receive(startEvent());
      expect(errors.map((e) => e.message)).toContain('Twilio media stream started twice');
    });
  });

  describe('outbound audio', () => {
    it('sends μ-law in 20 ms frames and the rest before a mark', async () => {
      const { socket, stream } = await started();
      const audio = Buffer.alloc(400);
      for (let i = 0; i < audio.length; i++) audio[i] = i & 0xff;
      stream.sendAudio(audio.subarray(0, 250));
      stream.sendAudio(audio.subarray(250));
      expect(payloads(socket.sent).map((p) => p.length)).toEqual([160, 160]);
      void stream.mark();
      expect(socket.sent.map((m) => m.event)).toEqual(['media', 'media', 'media', 'mark']);
      expect(Buffer.concat(payloads(socket.sent)).equals(audio)).toBe(true);
      expect(socket.sent.every((m) => m.streamSid === STREAM_SID)).toBe(true);
    });

    it('resamples and encodes PCM16 at another rate', async () => {
      const { socket, stream } = await started({
        outbound: { encoding: 'pcm16', sampleRate: 24000 },
      });
      const tone = new Float32Array(4800);
      for (let i = 0; i < tone.length; i++)
        tone[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / 24000);
      const pcm = float32ToPcm16(tone);
      for (let offset = 0; offset < pcm.length; offset += 999) {
        stream.sendAudio(pcm.subarray(offset, offset + 999));
      }
      void stream.mark();
      const sent = Buffer.concat(payloads(socket.sent));
      expect(sent).toHaveLength(1600);
      expect(
        payloads(socket.sent)
          .slice(0, -1)
          .every((p) => p.length === 160)
      ).toBe(true);
    });

    it('sends nothing before the stream started', () => {
      const { socket, stream } = setup();
      stream.sendAudio(Buffer.alloc(320));
      expect(socket.sent).toEqual([]);
    });
  });

  describe('marks and clear', () => {
    it('resolves a mark once Twilio echoes it, and the marks sent before it', async () => {
      const { socket, stream } = await started();
      const marks: Array<[string, boolean]> = [];
      stream.on('mark', (name, played) => marks.push([name, played]));
      stream.sendAudio(Buffer.alloc(160));
      const first = stream.mark();
      stream.sendAudio(Buffer.alloc(160));
      const second = stream.mark();
      const names = socket.sent
        .filter((m) => m.event === 'mark')
        .map((m) => (m.mark as { name: string }).name);
      expect(names).toHaveLength(2);
      socket.receive({ event: 'mark', streamSid: STREAM_SID, mark: { name: names[1] } });
      await expect(first).resolves.toBe(true);
      await expect(second).resolves.toBe(true);
      expect(marks).toEqual([
        [names[0], true],
        [names[1], true],
      ]);
    });

    it('clears the buffer and resolves the pending marks false', async () => {
      const { socket, stream } = await started();
      stream.sendAudio(Buffer.alloc(160));
      const first = stream.mark();
      stream.sendAudio(Buffer.alloc(160));
      const second = stream.mark();
      const [name1, name2] = socket.sent
        .filter((m) => m.event === 'mark')
        .map((m) => (m.mark as { name: string }).name);
      socket.receive({ event: 'mark', streamSid: STREAM_SID, mark: { name: name1 } });
      await expect(first).resolves.toBe(true);
      stream.clear();
      expect(socket.sent.at(-1)).toEqual({ event: 'clear', streamSid: STREAM_SID });
      await expect(second).resolves.toBe(false);
      socket.receive({ event: 'mark', streamSid: STREAM_SID, mark: { name: name2 } });
      await expect(second).resolves.toBe(false);
    });

    it('sends clear for audio sent without a mark, and nothing when all was played', async () => {
      const { socket, stream } = await started();
      stream.clear();
      expect(socket.sent).toEqual([]);
      stream.sendAudio(Buffer.alloc(160));
      stream.clear();
      expect(socket.sent.map((m) => m.event)).toEqual(['media', 'clear']);
      stream.sendAudio(Buffer.alloc(100));
      stream.clear();
      expect(socket.sent.map((m) => m.event)).toEqual(['media', 'clear']);
    });

    it('drops pending marks when Twilio stops the stream', async () => {
      const { socket, stream } = await started();
      const stopped = vi.fn();
      stream.on('stop', stopped);
      stream.sendAudio(Buffer.alloc(160));
      const pending = stream.mark();
      socket.receive({ event: 'stop', streamSid: STREAM_SID, stop: { callSid: 'CA0001' } });
      await expect(pending).resolves.toBe(false);
      expect(stopped).toHaveBeenCalledTimes(1);
      expect(socket.closed?.code).toBe(1000);
      await expect(stream.mark()).resolves.toBe(false);
    });

    it('drops pending marks when the socket closes', async () => {
      const { socket, stream } = await started();
      const pending = stream.mark();
      socket.close(1006);
      await expect(pending).resolves.toBe(false);
    });
  });

  it('counts any message as a sign of life', async () => {
    const { socket, stream } = await started();
    stream.markDead();
    expect(stream.isAlive).toBe(false);
    socket.receive(media(Buffer.from([1])));
    expect(stream.isAlive).toBe(true);
  });
});
