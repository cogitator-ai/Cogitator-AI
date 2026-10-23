import { z } from 'zod';
import type { ChannelButton } from '@cogitator-ai/types';

/** The content type of an Adaptive Card attachment. */
export const ADAPTIVE_CARD = 'application/vnd.microsoft.card.adaptive';
/** The content type of the card that asks a user to accept a file upload. */
export const FILE_CONSENT_CARD = 'application/vnd.microsoft.teams.card.file.consent';
/** The content type of the card that shows an uploaded file. */
export const FILE_INFO_CARD = 'application/vnd.microsoft.teams.card.file.info';
/** The `verb` of the `Action.Execute` buttons the channel sends. */
export const TEAMS_ACTION_VERB = 'cogitator';

/** An Adaptive Card, as JSON. */
export type AdaptiveCard = Record<string, unknown>;

const STYLES: Record<NonNullable<ChannelButton['style']>, string> = {
  primary: 'positive',
  success: 'positive',
  danger: 'destructive',
};

const COLORS: Record<NonNullable<ChannelButton['style']>, string> = {
  primary: 'accent',
  success: 'good',
  danger: 'attention',
};

function actionOf(button: ChannelButton): Record<string, unknown> {
  const style = button.style ? { style: STYLES[button.style] } : {};
  if (button.url !== undefined) {
    return { type: 'Action.OpenUrl', title: button.text, url: button.url, ...style };
  }
  if (button.copyText !== undefined) {
    return {
      type: 'Action.ShowCard',
      title: button.text,
      card: {
        type: 'AdaptiveCard',
        body: [{ type: 'TextBlock', text: button.copyText, wrap: true, fontType: 'Monospace' }],
      },
    };
  }
  if (button.data !== undefined) {
    const data = { [TEAMS_ACTION_VERB]: button.data };
    return {
      type: 'Action.Execute',
      title: button.text,
      verb: TEAMS_ACTION_VERB,
      data,
      ...style,
      fallback: { type: 'Action.Submit', title: button.text, data, ...style },
    };
  }
  throw new Error(`[teams] Button "${button.text}" needs data, url, copyText or disabled`);
}

/**
 * An Adaptive Card with rows of buttons, one action set per row. A button with `data` is an
 * `Action.Execute` that falls back to `Action.Submit` on clients without Universal Actions, a
 * `url` opens it, `copyText` shows the text to copy, and a disabled button is shown as text in
 * its color, since older clients cannot disable actions.
 */
export function buttonsCard(rows: ChannelButton[][]): AdaptiveCard {
  const body: Record<string, unknown>[] = [];
  for (const row of rows) {
    for (const button of row.filter((candidate) => candidate.disabled)) {
      body.push({
        type: 'TextBlock',
        text: button.text,
        weight: 'Bolder',
        wrap: true,
        ...(button.style && { color: COLORS[button.style] }),
      });
    }
    const actions = row.filter((button) => !button.disabled).map(actionOf);
    if (actions.length > 0) body.push({ type: 'ActionSet', actions });
  }
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body,
  };
}

const SubmitValueSchema = z.object({ [TEAMS_ACTION_VERB]: z.string() });

const ExecuteValueSchema = z.object({
  action: z.object({
    type: z.string().optional(),
    verb: z.string().optional(),
    data: z.unknown().optional(),
  }),
});

/** The button data of an `Action.Submit` press, the `value` of the message it sends. */
export function submitDataOf(value: unknown): string | undefined {
  const parsed = SubmitValueSchema.safeParse(value);
  return parsed.success ? parsed.data[TEAMS_ACTION_VERB] : undefined;
}

/** The button data of an `Action.Execute` press, the `value` of its `adaptiveCard/action` invoke. */
export function executeDataOf(value: unknown): string | undefined {
  const parsed = ExecuteValueSchema.safeParse(value);
  if (!parsed.success || parsed.data.action.verb !== TEAMS_ACTION_VERB) return undefined;
  return submitDataOf(parsed.data.action.data);
}
