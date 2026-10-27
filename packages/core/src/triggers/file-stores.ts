import { join, resolve } from 'node:path';
import type { InboxStore, RoutineStore, TimerStore } from '@cogitator-ai/types';
import { experimental_FileInboxStore } from './inbox';
import { experimental_FileRoutineStore } from './routine-stores';
import { FileTimerStore } from './timer-stores';

/** The stores of a trigger manager in one folder, as the CLI finds them */
export interface FileTriggerStores {
  dir: string;
  store: RoutineStore;
  schedules: TimerStore;
  inbox: InboxStore;
}

/** Where the file stores live by default: `COGITATOR_TRIGGERS_DIR`, else `.cogitator/triggers` of the working directory */
export function defaultTriggersDir(): string {
  return resolve(
    process.env.COGITATOR_TRIGGERS_DIR ?? join(process.cwd(), '.cogitator', 'triggers')
  );
}

/**
 * Experimental. The routine store (`routines.json`), schedules (`schedules/timers.json`) and inbox
 * (`inbox.json`) of a trigger manager in one folder, which the CLI (`cogitator schedule`,
 * `cogitator inbox`) reads and changes while the runtime runs. Spread it into
 * `experimental_triggers`: `{ ...experimental_fileTriggerStores(), routines, agents }`
 */
export function experimental_fileTriggerStores(
  dir: string = defaultTriggersDir()
): FileTriggerStores {
  const root = resolve(dir);
  return {
    dir: root,
    store: new experimental_FileRoutineStore(join(root, 'routines.json')),
    schedules: new FileTimerStore(join(root, 'schedules')),
    inbox: new experimental_FileInboxStore(join(root, 'inbox.json')),
  };
}
