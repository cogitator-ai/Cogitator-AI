# Bridge Examples

The agent bridge of `@cogitator-ai/bridge` (experimental): sessions of different harnesses hand each other jobs, ask questions on the way and report back, without waiting for each other.

## Prerequisites

```bash
pnpm install && pnpm build
```

No model and no API key: the example shows the protocol between the sessions, and plays both sides itself.

## Examples

| #   | File                 | Description                                                                                          |
| --- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| 01  | `01-two-sessions.ts` | A job from hand-over to report: inbox, question and answer, a held-back repeat, verification, a push |

## Running

```bash
npx tsx examples/bridge/01-two-sessions.ts
```

The example runs its own dispatcher on a throwaway folder. For the dispatcher of your machine:

```bash
cogitator bridge serve
cogitator bridge log --follow
```
