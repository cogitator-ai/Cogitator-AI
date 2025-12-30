/**
 * Approval Notifiers
 *
 * Features:
 * - Console notifier for development
 * - Webhook notifier for HTTP integrations
 * - Composite notifier for multiple channels
 */

import type { ApprovalNotifier, ApprovalRequest } from '@cogitator/types';

/**
 * Console notifier for development and debugging
 */
export class ConsoleNotifier implements ApprovalNotifier {
  private prefix: string;

  constructor(options: { prefix?: string } = {}) {
    this.prefix = options.prefix ?? '[Approval]';
  }

  async notify(request: ApprovalRequest): Promise<void> {
    console.log(
      `${this.prefix} New approval request: ${request.title}`,
      {
        id: request.id,
        type: request.type,
        assignee: request.assignee,
        priority: request.priority,
        deadline: request.deadline
          ? new Date(request.deadline).toISOString()
          : undefined,
      }
    );
  }

  async notifyEscalation(
    request: ApprovalRequest,
    reason: string
  ): Promise<void> {
    console.log(
      `${this.prefix} Escalation: ${request.title}`,
      {
        id: request.id,
        reason,
        escalateTo: request.escalateTo,
      }
    );
  }

  async notifyTimeout(request: ApprovalRequest): Promise<void> {
    console.log(
      `${this.prefix} Timeout: ${request.title}`,
      {
        id: request.id,
        action: request.timeoutAction,
      }
    );
  }

  async notifyDelegation(
    request: ApprovalRequest,
    from: string,
    to: string
  ): Promise<void> {
    console.log(
      `${this.prefix} Delegation: ${request.title}`,
      {
        id: request.id,
        from,
        to,
      }
    );
  }
}

/**
 * Webhook notifier for HTTP integrations (Slack, Teams, custom)
 */
export class WebhookNotifier implements ApprovalNotifier {
  private url: string;
  private headers: Record<string, string>;
  private formatPayload: (
    event: 'request' | 'escalation' | 'timeout' | 'delegation',
    request: ApprovalRequest,
    extra?: Record<string, unknown>
  ) => unknown;
  private timeout: number;

  constructor(options: {
    url: string;
    headers?: Record<string, string>;
    formatPayload?: (
      event: 'request' | 'escalation' | 'timeout' | 'delegation',
      request: ApprovalRequest,
      extra?: Record<string, unknown>
    ) => unknown;
    timeout?: number;
  }) {
    this.url = options.url;
    this.headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };
    this.formatPayload = options.formatPayload ?? this.defaultFormat;
    this.timeout = options.timeout ?? 10000;
  }

  private defaultFormat(
    event: 'request' | 'escalation' | 'timeout' | 'delegation',
    request: ApprovalRequest,
    extra?: Record<string, unknown>
  ): unknown {
    return {
      event,
      request: {
        id: request.id,
        workflowId: request.workflowId,
        runId: request.runId,
        nodeId: request.nodeId,
        type: request.type,
        title: request.title,
        description: request.description,
        assignee: request.assignee,
        assigneeGroup: request.assigneeGroup,
        priority: request.priority,
        deadline: request.deadline,
        createdAt: request.createdAt,
      },
      ...extra,
      timestamp: Date.now(),
    };
  }

  private async send(payload: unknown): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async notify(request: ApprovalRequest): Promise<void> {
    const payload = this.formatPayload('request', request);
    await this.send(payload);
  }

  async notifyEscalation(
    request: ApprovalRequest,
    reason: string
  ): Promise<void> {
    const payload = this.formatPayload('escalation', request, { reason });
    await this.send(payload);
  }

  async notifyTimeout(request: ApprovalRequest): Promise<void> {
    const payload = this.formatPayload('timeout', request, {
      action: request.timeoutAction,
    });
    await this.send(payload);
  }

  async notifyDelegation(
    request: ApprovalRequest,
    from: string,
    to: string
  ): Promise<void> {
    const payload = this.formatPayload('delegation', request, { from, to });
    await this.send(payload);
  }
}

/**
 * Slack-formatted webhook notifier
 */
export function slackNotifier(
  webhookUrl: string,
  options: {
    channel?: string;
    username?: string;
    iconEmoji?: string;
  } = {}
): WebhookNotifier {
  return new WebhookNotifier({
    url: webhookUrl,
    formatPayload: (event, request, extra) => {
      const priorityEmoji: Record<string, string> = {
        urgent: ':rotating_light:',
        high: ':warning:',
        normal: ':bell:',
        low: ':information_source:',
      };

      const emoji = priorityEmoji[request.priority ?? 'normal'];

      let text: string;
      switch (event) {
        case 'request':
          text = `${emoji} *New Approval Request*\n*${request.title}*${
            request.description ? `\n${request.description}` : ''
          }`;
          break;
        case 'escalation':
          text = `:arrow_up: *Escalation*\n*${request.title}*\nReason: ${extra?.reason}\nEscalated to: ${request.escalateTo}`;
          break;
        case 'timeout':
          text = `:hourglass: *Timeout*\n*${request.title}*\nAction: ${request.timeoutAction}`;
          break;
        case 'delegation':
          text = `:arrow_right: *Delegation*\n*${request.title}*\nFrom: ${extra?.from} → To: ${extra?.to}`;
          break;
      }

      return {
        channel: options.channel,
        username: options.username ?? 'Approval Bot',
        icon_emoji: options.iconEmoji ?? ':clipboard:',
        text,
        attachments: [
          {
            color: request.priority === 'urgent' ? 'danger' : 'warning',
            fields: [
              { title: 'ID', value: request.id, short: true },
              { title: 'Type', value: request.type, short: true },
              { title: 'Assignee', value: request.assignee ?? 'Unassigned', short: true },
              { title: 'Priority', value: request.priority ?? 'normal', short: true },
            ],
          },
        ],
      };
    },
  });
}

/**
 * Composite notifier that sends to multiple channels
 */
export class CompositeNotifier implements ApprovalNotifier {
  private notifiers: ApprovalNotifier[];
  private continueOnError: boolean;

  constructor(
    notifiers: ApprovalNotifier[],
    options: { continueOnError?: boolean } = {}
  ) {
    this.notifiers = notifiers;
    this.continueOnError = options.continueOnError ?? true;
  }

  async notify(request: ApprovalRequest): Promise<void> {
    await this.fanOut((n) => n.notify(request));
  }

  async notifyEscalation(
    request: ApprovalRequest,
    reason: string
  ): Promise<void> {
    await this.fanOut((n) => n.notifyEscalation(request, reason));
  }

  async notifyTimeout(request: ApprovalRequest): Promise<void> {
    await this.fanOut((n) => n.notifyTimeout(request));
  }

  async notifyDelegation(
    request: ApprovalRequest,
    from: string,
    to: string
  ): Promise<void> {
    await this.fanOut((n) => n.notifyDelegation(request, from, to));
  }

  private async fanOut(
    fn: (notifier: ApprovalNotifier) => Promise<void>
  ): Promise<void> {
    const errors: Error[] = [];

    for (const notifier of this.notifiers) {
      try {
        await fn(notifier);
      } catch (error) {
        if (this.continueOnError) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        } else {
          throw error;
        }
      }
    }

    if (errors.length > 0) {
      const combined = new AggregateError(
        errors,
        `${errors.length} notifier(s) failed`
      );
      throw combined;
    }
  }
}

/**
 * Filtered notifier that only notifies for certain requests
 */
export function filteredNotifier(
  notifier: ApprovalNotifier,
  filter: (request: ApprovalRequest) => boolean
): ApprovalNotifier {
  return {
    async notify(request) {
      if (filter(request)) {
        await notifier.notify(request);
      }
    },
    async notifyEscalation(request, reason) {
      if (filter(request)) {
        await notifier.notifyEscalation(request, reason);
      }
    },
    async notifyTimeout(request) {
      if (filter(request)) {
        await notifier.notifyTimeout(request);
      }
    },
    async notifyDelegation(request, from, to) {
      if (filter(request)) {
        await notifier.notifyDelegation(request, from, to);
      }
    },
  };
}

/**
 * Priority-based notifier routing
 */
export function priorityRouter(options: {
  urgent?: ApprovalNotifier;
  high?: ApprovalNotifier;
  normal?: ApprovalNotifier;
  low?: ApprovalNotifier;
  default?: ApprovalNotifier;
}): ApprovalNotifier {
  const getNotifier = (request: ApprovalRequest): ApprovalNotifier | undefined => {
    switch (request.priority) {
      case 'urgent':
        return options.urgent ?? options.default;
      case 'high':
        return options.high ?? options.default;
      case 'normal':
        return options.normal ?? options.default;
      case 'low':
        return options.low ?? options.default;
      default:
        return options.default;
    }
  };

  return {
    async notify(request) {
      const notifier = getNotifier(request);
      await notifier?.notify(request);
    },
    async notifyEscalation(request, reason) {
      const notifier = getNotifier(request);
      await notifier?.notifyEscalation(request, reason);
    },
    async notifyTimeout(request) {
      const notifier = getNotifier(request);
      await notifier?.notifyTimeout(request);
    },
    async notifyDelegation(request, from, to) {
      const notifier = getNotifier(request);
      await notifier?.notifyDelegation(request, from, to);
    },
  };
}

/**
 * Null notifier that does nothing (useful for testing)
 */
export const nullNotifier: ApprovalNotifier = {
  async notify() {},
  async notifyEscalation() {},
  async notifyTimeout() {},
  async notifyDelegation() {},
};
