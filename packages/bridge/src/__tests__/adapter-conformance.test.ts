import { afterEach, describe, expect, it } from 'vitest';
import { hostedAdapter } from '../adapters/hosted';
import { adapterConformanceCases, type AdapterConformanceTarget } from '../testing/conformance';
import { socketDir } from './helpers';

const folders: (() => void)[] = [];

afterEach(() => {
  for (const remove of folders.splice(0)) remove();
});

function home(): string {
  const folder = socketDir();
  folders.push(folder.remove);
  return folder.dir;
}

/** Hosted sessions whose agent only remembers what it was told */
function hostedTarget(): AdapterConformanceTarget {
  const heard = new Map<string, string[]>();
  return {
    home,
    cwd: '/work/demo',
    supports: ['createSession', 'liveSessions'],
    create: () =>
      hostedAdapter({
        harness: 'echo',
        steer: true,
        open: ({ sessionId }) => {
          const texts: string[] = [];
          heard.set(sessionId, texts);
          return {
            turn: (text) => {
              texts.push(text);
              let stop = (): void => undefined;
              return {
                result: new Promise<string>((_, reject) => {
                  stop = () => reject(new Error('stopped'));
                }),
                steer: (message) => texts.push(message) > 0,
                abort: () => stop(),
              };
            },
          };
        },
      }),
    received: async (sessionId, needle) => {
      const deadline = Date.now() + 5_000;
      while (!heard.get(sessionId)?.some((text) => text.includes(needle))) {
        if (Date.now() > deadline) throw new Error(`The session never got "${needle}"`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

describe('the adapter contract, kept by hosted sessions', () => {
  for (const conformance of adapterConformanceCases(hostedTarget())) {
    it.skipIf(conformance.skip !== undefined)(conformance.name, () => conformance.run());
  }

  it('skips the cases of what the adapter does not claim, with the reason', () => {
    const cases = adapterConformanceCases({
      ...hostedTarget(),
      skip: { 'delivers-a-letter': 'covered elsewhere' },
    });

    expect(Object.fromEntries(cases.map((entry) => [entry.name, entry.skip]))).toEqual({
      'declares-itself': undefined,
      'starts-a-session': undefined,
      'delivers-a-letter': 'covered elsewhere',
      'lists-its-sessions': undefined,
      'identifies-its-sessions': 'the adapter has no identify',
      'reports-health': 'the adapter has no health',
    });
  });

  it('notices an adapter that lost something its target says it has', async () => {
    const target = {
      ...hostedTarget(),
      supports: ['createSession', 'liveSessions', 'health'] as const,
    };
    const [declares] = adapterConformanceCases(target);

    await expect(declares.run()).rejects.toThrow(
      'the adapter has what the target says it supports, no more and no less'
    );
  });
});
