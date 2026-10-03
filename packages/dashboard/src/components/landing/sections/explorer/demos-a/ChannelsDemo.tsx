'use client';

import { AnimatePresence, m } from 'framer-motion';
import { CheckCheck, Globe, Hash } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { siDiscord, siTelegram, siWhatsapp, type SimpleIcon } from 'simple-icons';
import { cx, Vox } from '../../../ui';
import { EASE, useDemoTimeline } from './shared';

type SkinId = 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'webchat';

interface Skin {
  id: SkinId;
  label: string;
  icon: SimpleIcon | ComponentType<{ className?: string }>;
  layout: 'bubbles' | 'rows';
  userBubble: string;
  botName: string;
}

const SKINS: Skin[] = [
  {
    id: 'telegram',
    label: 'Telegram',
    icon: siTelegram,
    layout: 'bubbles',
    userBubble: 'bg-[#2AABEE]/20',
    botName: 'text-[#5fc3f2]',
  },
  {
    id: 'discord',
    label: 'Discord',
    icon: siDiscord,
    layout: 'rows',
    userBubble: '',
    botName: 'text-[#8b93f8]',
  },
  {
    id: 'slack',
    label: 'Slack',
    icon: Hash,
    layout: 'rows',
    userBubble: '',
    botName: 'text-l-text',
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    icon: siWhatsapp,
    layout: 'bubbles',
    userBubble: 'bg-[#25D366]/15',
    botName: 'text-[#4fd98a]',
  },
  {
    id: 'webchat',
    label: 'WebChat',
    icon: Globe,
    layout: 'bubbles',
    userBubble: 'bg-l-accent/10',
    botName: 'text-l-accent',
  },
];

const CONVERSATION_STEPS = 4;
const DURATIONS = [900, 1500, 1100, 1600, 800, 800, 800, 1500] as const;

function isSimpleIcon(icon: Skin['icon']): icon is SimpleIcon {
  return typeof icon === 'object' && 'path' in icon;
}

function SkinIcon({ skin, className }: { skin: Skin; className?: string }) {
  const { icon } = skin;
  if (isSimpleIcon(icon)) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden className={cx('fill-current', className)}>
        <path d={icon.path} />
      </svg>
    );
  }
  const Icon = icon;
  return <Icon className={className} />;
}

interface Message {
  from: 'user' | 'bot';
  body: ReactNode;
}

const APPROVAL_PROMPT = (
  <>
    <p>I need your approval before running this action:</p>
    <p className="mt-1">
      <span className="font-semibold">reschedule_event</span> — Move a calendar event
    </p>
    <code className="mt-1 block truncate rounded bg-black/30 px-1.5 py-0.5 font-mono text-[10.5px] text-l-muted">
      {'{"event":"1:1 with Dana","to":"Thu 15:00"}'}
    </code>
    <p className="mt-1 text-l-muted">
      Reply &quot;approve&quot; or &quot;yes&quot; to allow it, or &quot;deny&quot; or
      &quot;no&quot; to refuse.
    </p>
  </>
);

const MESSAGES: Message[] = [
  { from: 'user', body: 'Move my 3pm with Dana to Thursday' },
  { from: 'bot', body: APPROVAL_PROMPT },
  { from: 'user', body: 'approve' },
  { from: 'bot', body: 'Done, moved to Thursday at 3:00 PM. Dana has the new invite.' },
];

function Bubble({ message, skin }: { message: Message; skin: Skin }) {
  const mine = message.from === 'user';
  return (
    <div
      className={cx(
        'w-fit max-w-[88%] rounded-2xl px-3 py-1.5 text-[11.5px] leading-snug text-l-text sm:text-[12px]',
        mine ? cx('ml-auto rounded-br-md', skin.userBubble) : 'rounded-bl-md bg-white/[0.06]'
      )}
    >
      {message.body}
      {mine && skin.id === 'whatsapp' && (
        <CheckCheck className="ml-1 inline size-3 align-[-2px] text-[#53bdeb]" />
      )}
    </div>
  );
}

function Row({ message, skin }: { message: Message; skin: Skin }) {
  const bot = message.from === 'bot';
  return (
    <div className="flex gap-2.5 text-[11.5px] leading-snug sm:text-[12px]">
      <span
        className={cx(
          'mt-0.5 flex size-6 shrink-0 items-center justify-center text-[10px] font-semibold',
          skin.id === 'slack' ? 'rounded-md' : 'rounded-full',
          bot ? 'bg-l-brass/20 text-l-brass' : 'bg-white/10 text-l-muted'
        )}
      >
        {bot ? 'C' : 'A'}
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={cx('font-semibold', bot ? skin.botName : 'text-l-text')}>
            {bot ? 'concierge' : 'alice'}
          </span>
          {bot && (
            <span className="rounded-[3px] bg-white/10 px-1 text-[9px] font-semibold text-l-muted">
              APP
            </span>
          )}
        </div>
        <div className="text-l-text/90">{message.body}</div>
      </div>
    </div>
  );
}

/** One Gateway, five channel skins: the same assistant asks for approval in chat. */
export function ChannelsDemo() {
  const { ref, step, loop } = useDemoTimeline(DURATIONS);
  const shown = Math.min(step + 1, CONVERSATION_STEPS);
  const skin = SKINS[(loop + Math.max(0, step - (CONVERSATION_STEPS - 1))) % SKINS.length];

  return (
    <div ref={ref} className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-l-line px-3">
        {SKINS.map((candidate) => (
          <span
            key={candidate.id}
            title={candidate.label}
            className={cx(
              'flex size-6 items-center justify-center rounded-md transition-colors duration-300',
              candidate.id === skin.id ? 'bg-white/[0.08] text-l-text' : 'text-l-faint'
            )}
          >
            <SkinIcon skin={candidate} className="size-3.5" />
          </span>
        ))}
        <span className="ml-2 hidden font-mono text-[11px] text-l-faint sm:inline">
          gateway · {skin.label.toLowerCase()}
        </span>
        <span className="ml-auto">
          {step === 1 ? (
            <Vox tone="warn">awaiting sanction</Vox>
          ) : step === 2 ? (
            <Vox>sanction granted</Vox>
          ) : null}
        </span>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <m.div
          key={skin.id}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="flex min-h-0 flex-1 flex-col justify-end gap-2.5 overflow-hidden [&>*]:shrink-0 px-4 py-3"
        >
          {MESSAGES.slice(0, shown).map((message, index) => (
            <m.div
              key={index}
              initial={step === index ? { opacity: 0, y: 8 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: EASE }}
            >
              {skin.layout === 'bubbles' ? (
                <Bubble message={message} skin={skin} />
              ) : (
                <Row message={message} skin={skin} />
              )}
            </m.div>
          ))}
        </m.div>
      </AnimatePresence>
    </div>
  );
}
