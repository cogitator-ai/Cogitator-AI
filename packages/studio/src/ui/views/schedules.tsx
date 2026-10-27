import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot,
  CalendarClock,
  CircleCheck,
  Info,
  Pause,
  Play,
  Power,
  PowerOff,
  Workflow,
  Zap,
} from 'lucide-react';
import type { RoutineRunStatus, TriggerFireResult } from '@cogitator-ai/types';
import type { RoutineRecord, ScheduleRecord, TriggerRecord, TriggersState } from '../../protocol';
import { api } from '../api';
import { Empty, ErrorText, messageOf, Topbar } from '../components/common';
import { excerpt, formatTime, timeAgo } from '../format';
import { href } from '../router';
import { useStudio } from '../store';

const REFRESH_MS = 5000;

const HISTORY_LABEL: Record<RoutineRunStatus, string> = {
  started: 'Started',
  queued: 'Queued',
  skipped: 'Skipped',
  completed: 'Completed',
  failed: 'Failed',
  paused: 'Waits',
  replaced: 'Replaced',
};

const ORIGIN_LABEL: Record<RoutineRecord['origin'], string> = {
  code: 'Code',
  store: 'Store',
  plugin: 'Plugin',
};

/** What the last button pressed on the page came to. */
interface Outcome {
  ok: boolean;
  text: string;
}

function fireText(result: TriggerFireResult): string {
  switch (result.status) {
    case 'started':
      return `${result.triggerId} started run ${result.runId ?? ''}, its outcome comes to the inbox.`;
    case 'queued':
      return `${result.triggerId} is queued behind a run going on.`;
    case 'skipped':
      return `${result.triggerId} was skipped${result.reason ? `: ${result.reason}` : ''}.`;
    case 'duplicate':
      return `${result.triggerId} fired this event before${result.reason ? `: ${result.reason}` : ''}.`;
  }
}

/** What a trigger reacts to, in a line: its schedule, or the events it takes. */
function triggerWhat(trigger: TriggerRecord): string {
  const spec = trigger.spec;
  if (trigger.kind === 'cron') {
    const zone = typeof spec.timezone === 'string' ? ` ${spec.timezone}` : '';
    return `${String(spec.cron ?? '')}${zone}`;
  }
  if (Array.isArray(spec.events) && spec.events.length > 0) return spec.events.join(', ');
  if (trigger.kind === 'api') return `POST /triggers/${trigger.id}/fire`;
  return `POST /triggers/${trigger.id}/webhook`;
}

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <span className="status" data-status={enabled ? 'active' : 'paused'}>
      {enabled ? 'On' : 'Paused'}
    </span>
  );
}

function TriggerRow({
  trigger,
  busy,
  onFire,
  onToggle,
}: {
  trigger: TriggerRecord;
  busy: boolean;
  onFire: () => void;
  onToggle: () => void;
}) {
  return (
    <div className="tr trigger-row" role="row" data-testid={`trigger-${trigger.id}`}>
      <span role="cell">
        <span className="chip">{trigger.kind}</span>
      </span>
      <span role="cell" className="truncate">
        <span className="mono">{trigger.id}</span>
        <span className="muted truncate trigger-what"> {triggerWhat(trigger)}</span>
      </span>
      <span role="cell">
        <EnabledBadge enabled={trigger.enabled} />
      </span>
      <span role="cell" className="muted" title={trigger.lastError}>
        {trigger.nextFireAt !== undefined ? `next ${formatTime(trigger.nextFireAt)}` : ''}
        {trigger.nextFireAt !== undefined && trigger.lastFiredAt !== undefined && <br />}
        {trigger.lastFiredAt !== undefined
          ? `fired ${timeAgo(trigger.lastFiredAt)}, ${trigger.fireCount} in all`
          : trigger.nextFireAt === undefined
            ? 'never fired'
            : ''}
      </span>
      <span role="cell" className="row-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy}
          onClick={onFire}
          data-testid="fire-trigger"
        >
          <Zap size={12} />
          Run now
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy}
          onClick={onToggle}
          data-testid="toggle-trigger"
        >
          {trigger.enabled ? <Pause size={12} /> : <Play size={12} />}
          {trigger.enabled ? 'Pause' : 'Resume'}
        </button>
      </span>
    </div>
  );
}

function RoutineCard({
  routine,
  busy,
  focused,
  act,
}: {
  routine: RoutineRecord;
  busy: boolean;
  focused: boolean;
  act: (work: () => Promise<Outcome>) => void;
}) {
  const [text, setText] = useState('');
  const card = useRef<HTMLElement>(null);

  useEffect(() => {
    if (focused) card.current?.scrollIntoView({ block: 'start' });
  }, [focused]);

  const fire = (trigger: TriggerRecord) =>
    act(async () => {
      const result = await api.fireTrigger(trigger.id, text.trim() || undefined);
      return {
        ok: result.status === 'started' || result.status === 'queued',
        text: fireText(result),
      };
    });
  const toggle = (trigger: TriggerRecord) =>
    act(async () => {
      await api.schedule(trigger.id, trigger.enabled ? 'pause' : 'resume');
      return { ok: true, text: `${trigger.id} is ${trigger.enabled ? 'paused' : 'on again'}.` };
    });
  const TargetIcon = routine.target.kind === 'agent' ? Bot : Workflow;

  return (
    <section
      ref={card}
      className={`panel plugin-card ${focused ? 'is-focused' : ''}`}
      data-testid={`routine-${routine.id}`}
    >
      <div className="panel-head">
        <div className="panel-title plugin-title">
          <CalendarClock size={14} />
          <span className="truncate">{routine.name ?? routine.id}</span>
          {routine.name && <span className="chip">{routine.id}</span>}
          <span
            className="chip"
            data-tip={`Runs the ${routine.target.kind} ${routine.target.name}`}
          >
            <TargetIcon size={12} />
            {routine.target.name}
          </span>
        </div>
        <div className="plugin-actions">
          {routine.active > 0 && (
            <span className="status" data-status="running">
              {routine.active} running
            </span>
          )}
          {routine.queued > 0 && (
            <span className="status" data-status="queued">
              {routine.queued} queued
            </span>
          )}
          {!routine.enabled && (
            <span className="status" data-status="paused">
              Disabled
            </span>
          )}
        </div>
      </div>
      <div className="panel-body plugin-body">
        {routine.description && <p className="panel-desc">{routine.description}</p>}
        <dl className="kv">
          <dt>Task</dt>
          <dd className="routine-prompt">{routine.prompt}</dd>
          <dt>Defined</dt>
          <dd>
            {ORIGIN_LABEL[routine.origin]}
            {routine.plugin && (
              <>
                {' '}
                <a href={href('plugins', routine.plugin)}>{routine.plugin}</a>
              </>
            )}
          </dd>
          <dt>Overlap</dt>
          <dd>
            {routine.overlap}
            {routine.maxConcurrent !== undefined && `, at most ${routine.maxConcurrent} at once`}
          </dd>
          <dt>Thread</dt>
          <dd className={routine.session === 'new' ? undefined : 'mono'}>
            {routine.session === 'new' ? 'A new one per firing' : routine.session}
          </dd>
        </dl>
        <div className="plugin-section">
          <div className="field-title">Triggers</div>
          {routine.triggers.length === 0 ? (
            <div className="muted">None: the routine runs only when fired from code.</div>
          ) : (
            <>
              <div className="table" role="table" aria-label={`Triggers of ${routine.id}`}>
                {routine.triggers.map((trigger) => (
                  <TriggerRow
                    key={trigger.id}
                    trigger={trigger}
                    busy={busy}
                    onFire={() => fire(trigger)}
                    onToggle={() => toggle(trigger)}
                  />
                ))}
              </div>
              <input
                className="input routine-text"
                placeholder="Text a run by hand gets as its event (optional)"
                value={text}
                onChange={(event) => setText(event.target.value)}
                aria-label={`Text for a run of ${routine.id} by hand`}
              />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function scheduleOwner(entry: ScheduleRecord): string {
  return entry.owner.kind === 'routine'
    ? `${entry.owner.routineId}.${entry.owner.triggerId}`
    : `${entry.owner.agent}: ${entry.owner.description ?? entry.name ?? 'a task'}`;
}

function scheduleWhen(entry: ScheduleRecord): string {
  if (entry.cron) return `${entry.cron}${entry.timezone ? ` ${entry.timezone}` : ''}`;
  if (entry.interval) return `every ${Math.round(entry.interval / 1000)} s`;
  return 'once';
}

function SchedulesTable({
  schedules,
  started,
  busy,
  act,
}: {
  schedules: ScheduleRecord[];
  started: boolean;
  busy: boolean;
  act: (work: () => Promise<Outcome>) => void;
}) {
  if (schedules.length === 0)
    return (
      <div className="panel">
        <Empty icon={CalendarClock} title="Nothing scheduled">
          Cron triggers get their entries once the triggers start, tasks agents schedule with{' '}
          <code>schedule_task</code> show up as they make them.
        </Empty>
      </div>
    );
  const run = (entry: ScheduleRecord) =>
    act(async () => {
      await api.schedule(entry.id, 'run');
      return { ok: true, text: `${scheduleOwner(entry)} fires on the next poll.` };
    });
  const toggle = (entry: ScheduleRecord) =>
    act(async () => {
      await api.schedule(entry.id, entry.enabled ? 'pause' : 'resume');
      return {
        ok: true,
        text: `${scheduleOwner(entry)} is ${entry.enabled ? 'paused' : 'on again'}.`,
      };
    });
  return (
    <div className="table" role="table" aria-label="Schedules">
      <div className="tr thead schedule-row" role="row">
        <span role="columnheader">What</span>
        <span role="columnheader">When</span>
        <span role="columnheader">Next</span>
        <span role="columnheader">Last run</span>
        <span role="columnheader">State</span>
        <span role="columnheader" />
      </div>
      {schedules.map((entry) => (
        <div key={entry.id} className="tr schedule-row" role="row" data-testid="schedule-row">
          <span role="cell" className="td-target">
            {entry.owner.kind === 'agent' ? <Bot size={14} /> : <CalendarClock size={14} />}
            <span className="truncate" title={entry.id}>
              {scheduleOwner(entry)}
            </span>
          </span>
          <span role="cell" className="mono muted truncate">
            {scheduleWhen(entry)}
          </span>
          <span role="cell" className="muted">
            {formatTime(entry.firesAt)}
          </span>
          <span role="cell" className="muted truncate" title={entry.lastError}>
            {entry.lastRunAt !== undefined
              ? `${entry.lastRunStatus ?? 'ran'} ${timeAgo(entry.lastRunAt)}`
              : 'never'}
          </span>
          <span role="cell">
            <EnabledBadge enabled={entry.enabled} />
          </span>
          <span role="cell" className="row-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy || !started || !entry.enabled}
              data-tip={!started ? 'Start the triggers first' : undefined}
              onClick={() => run(entry)}
              data-testid="run-schedule"
            >
              <Zap size={12} />
              Run now
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => toggle(entry)}
              data-testid="toggle-schedule"
            >
              {entry.enabled ? <Pause size={12} /> : <Play size={12} />}
              {entry.enabled ? 'Pause' : 'Resume'}
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

function HistoryTable({ history }: { history: TriggersState['history'] }) {
  if (history.length === 0)
    return (
      <div className="panel">
        <Empty icon={Zap} title="No firings yet">
          Every firing of a routine shows up here: started, queued, skipped or failed.
        </Empty>
      </div>
    );
  return (
    <div className="table" role="table" aria-label="History">
      <div className="tr thead history-row" role="row">
        <span role="columnheader">Status</span>
        <span role="columnheader">Trigger</span>
        <span role="columnheader">Source</span>
        <span role="columnheader">Run</span>
        <span role="columnheader">Reason</span>
        <span role="columnheader" className="td-right">
          When
        </span>
      </div>
      {history.map((record) => (
        <div key={record.id} className="tr history-row" role="row" data-testid="history-row">
          <span role="cell">
            <span className="status" data-status={record.status}>
              {HISTORY_LABEL[record.status]}
            </span>
          </span>
          <span role="cell" className="mono truncate">
            {record.triggerId}
          </span>
          <span role="cell" className="muted">
            {record.source}
          </span>
          <span role="cell" className="mono muted truncate" title={record.runId}>
            {record.runId ?? ''}
          </span>
          <span role="cell" className="muted truncate" title={record.reason}>
            {record.reason ? excerpt(record.reason, 120) : ''}
          </span>
          <span role="cell" className="td-right muted" title={formatTime(record.at)}>
            {timeAgo(record.at)}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The routines of the project's runtime and what starts them: their triggers with Run now, Pause
 * and Resume, the pending schedule entries, tasks agents gave themselves among them, and the latest
 * firings. The triggers start only when Start is pressed, as routines may call real models.
 */
export function SchedulesView({ focus }: { focus?: string }) {
  const host = useStudio((state) => state.host);
  const revision = useStudio((state) => state.inbox?.revision ?? 0);
  const [state, setState] = useState<TriggersState>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const loadedAt = host.state === 'ready' ? host.loadedAt : 0;

  const load = useCallback(async () => {
    try {
      setState(await api.schedules());
      setError(undefined);
    } catch (failure) {
      setError(messageOf(failure));
    }
  }, []);

  useEffect(() => {
    if (!loadedAt) return;
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, loadedAt, revision]);

  const act = (work: () => Promise<Outcome>) => {
    setBusy(true);
    setOutcome(undefined);
    work()
      .then((done) => setOutcome(done))
      .catch((failure: unknown) => setOutcome({ ok: false, text: messageOf(failure) }))
      .finally(() => {
        setBusy(false);
        void load();
      });
  };

  const switchTriggers = (start: boolean) =>
    act(async () => {
      const next = await api.startTriggers(start);
      setState(next);
      return {
        ok: true,
        text: start
          ? 'Started: schedules fire and agents run their tasks.'
          : 'Stopped: schedules wait, runs going on finish.',
      };
    });

  const crumbs = [{ label: 'Schedules' }];
  if (!state)
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="scroll">
          {error ? (
            <div className="page">
              <ErrorText>{error}</ErrorText>
            </div>
          ) : (
            <Empty icon={CalendarClock} title="Waiting for the project">
              {host.state === 'failed' ? 'The project does not load.' : undefined}
            </Empty>
          )}
        </div>
      </>
    );
  if (!state.configured)
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="scroll">
          <Empty icon={CalendarClock} title="No routines in this runtime">
            Routines are saved tasks a schedule, an API call, a webhook or an event starts. Give the
            Cogitator config <code>experimental_triggers</code> with <code>agents</code> and{' '}
            <code>routines</code> to see their triggers, schedules and history here.
          </Empty>
        </div>
      </>
    );

  return (
    <>
      <Topbar
        crumbs={crumbs}
        actions={
          <button
            type="button"
            className={`btn btn-sm ${state.started ? 'btn-secondary' : 'btn-primary'}`}
            disabled={busy}
            onClick={() => switchTriggers(!state.started)}
            data-testid="switch-triggers"
          >
            {busy ? (
              <span className="spinner" />
            ) : state.started ? (
              <PowerOff size={12} />
            ) : (
              <Power size={12} />
            )}
            {state.started ? 'Stop' : 'Start'}
          </button>
        }
      />
      <div className="scroll">
        <div className="page">
          <div className="page-head">
            <div>
              <h1 className="page-title">Schedules</h1>
              <div className="page-sub">
                {state.routines.length} {state.routines.length === 1 ? 'routine' : 'routines'},
                triggers {state.started ? 'started' : 'not started'}
              </div>
            </div>
          </div>
          {!state.started && (
            <div className="notice" style={{ marginBottom: 16 }} data-testid="triggers-stopped">
              <Info size={14} />
              <span>
                The triggers are not started, so schedules do not fire. The studio starts them only
                when you press Start, as routines may call real models. Run now fires a trigger by
                hand either way.
              </span>
            </div>
          )}
          {outcome &&
            (outcome.ok ? (
              <div className="notice plugin-outcome" role="status" style={{ marginBottom: 16 }}>
                <CircleCheck size={14} />
                <span>{outcome.text}</span>
              </div>
            ) : (
              <ErrorText>{outcome.text}</ErrorText>
            ))}
          {error && <ErrorText>{error}</ErrorText>}
          <div className="plugin-list">
            {state.routines.length === 0 && (
              <div className="panel">
                <Empty icon={CalendarClock} title="No routines">
                  The runtime has a trigger manager without routines yet.
                </Empty>
              </div>
            )}
            {state.routines.map((routine) => (
              <RoutineCard
                key={routine.id}
                routine={routine}
                busy={busy}
                focused={routine.id === focus}
                act={act}
              />
            ))}
          </div>
          <h2 className="section-title">Scheduled</h2>
          <SchedulesTable
            schedules={state.schedules}
            started={state.started}
            busy={busy}
            act={act}
          />
          <h2 className="section-title">Recent firings</h2>
          <HistoryTable history={state.history} />
        </div>
      </div>
    </>
  );
}
