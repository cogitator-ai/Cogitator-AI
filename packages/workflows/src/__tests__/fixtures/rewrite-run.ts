import { FileRunStore } from '../../manager/run-store';
import type { WorkflowRun } from '@cogitator-ai/types';

/** Rewrites one run's file as fast as it can, with a large state, until it is killed. */
const [directory] = process.argv.slice(2);
const store = new FileRunStore({ directory, cacheTTL: 0 });
const base: WorkflowRun = {
  id: 'crash-run',
  workflowName: 'publish',
  status: 'running',
  state: { notes: 'x'.repeat(2_000) },
  currentNodes: [],
  completedNodes: [],
  failedNodes: [],
  startedAt: Date.now(),
  priority: 0,
  tags: [],
};
let round = 0;
for (;;) {
  round++;
  await store.save({
    ...base,
    status: round % 2 ? 'running' : 'waiting',
    state: { ...base.state, round },
  });
  if (round === 1) process.stdout.write('READY\n');
}
