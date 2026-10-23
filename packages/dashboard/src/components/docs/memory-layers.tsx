interface Layer {
  name: string;
  state: string;
  what: string;
  /** On as soon as memory is configured, rather than opt-in */
  on: boolean;
}

/** The stack, top first: what the model sees, down to the store everything rests on */
const STACK: readonly Layer[] = [
  {
    name: 'Context of a turn',
    state: 'with contextBuilder',
    what: 'system, pinned, memory index, summaries, facts, recall, brief, newest turns, input',
    on: true,
  },
  {
    name: 'Retrieval',
    state: 'hybrid with embeddings',
    what: 'recent, relevant or hybrid: the newest turns plus what matches the turn',
    on: true,
  },
  {
    name: 'Message index',
    state: 'with embeddings',
    what: 'every message embedded once, in the background, so the whole thread is searched',
    on: true,
  },
  {
    name: 'Memory items',
    state: 'written by extraction',
    what: 'facts, events, preferences, lessons: quoted, trusted by source, kept in time',
    on: false,
  },
  {
    name: 'Memory files',
    state: 'opt-in',
    what: 'notes under /memories through the memory tool, observations, the playbook',
    on: false,
  },
  {
    name: 'Thread entries',
    state: 'always',
    what: 'a tree of entries: branches, rewind, fork, forget and redact',
    on: true,
  },
  {
    name: 'Store',
    state: 'always',
    what: 'SQLite, Postgres, Redis, MongoDB or in process, and a vector store',
    on: true,
  },
];

/** The stages that run around the stack */
const STAGES: readonly Layer[] = [
  {
    name: 'Before a turn',
    state: 'opt-in',
    what: 'a brief of cards that quote their sources',
    on: false,
  },
  {
    name: 'After a run',
    state: 'opt-in',
    what: 'compaction, extraction, observations and consolidation',
    on: false,
  },
];

function Band({ layer }: { layer: Layer }) {
  return (
    <li
      className={`flex flex-col gap-1 rounded-lg border border-fd-border px-4 py-3 sm:flex-row sm:items-center sm:gap-4 ${
        layer.on ? 'bg-fd-muted' : 'bg-fd-background'
      }`}
    >
      <div className="sm:w-44 sm:shrink-0">
        <div className="font-medium text-fd-foreground">{layer.name}</div>
        <div className="text-xs text-fd-muted-foreground">{layer.state}</div>
      </div>
      <div className="text-sm text-fd-foreground">{layer.what}</div>
    </li>
  );
}

/**
 * The layers of Cogitator memory for the docs: the stack from the store up to the context of a
 * turn, then the stages around it. Filled bands are on once memory is configured, plain ones
 * are opt-in. HTML rather than a picture, so it reflows on a phone and follows the theme.
 */
export function MemoryLayers() {
  return (
    <figure className="not-prose my-6" aria-label="Layers of Cogitator memory">
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {STACK.map((layer) => (
          <Band key={layer.name} layer={layer} />
        ))}
      </ol>
      <ul className="mt-4 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2">
        {STAGES.map((layer) => (
          <Band key={layer.name} layer={layer} />
        ))}
      </ul>
    </figure>
  );
}
