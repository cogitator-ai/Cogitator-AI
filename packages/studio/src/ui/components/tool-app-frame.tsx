import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppWindow, ShieldAlert } from 'lucide-react';
import { PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { ToolAppFrameInfo, ToolCallRecord } from '../../protocol';
import { appAllowAttribute, TOOL_APP_SANDBOX } from '../../tool-app-policy';
import { api, toolAppUrl } from '../api';
import {
  createConfirmQueue,
  createToolAppHost,
  type ConfirmQueue,
  type PendingAppCall,
  type ToolAppHost,
} from '../tool-app-host';
import { pretty } from '../format';
import { resolvedTheme } from '../theme';
import { ErrorText, messageOf } from './common';

const MIN_HEIGHT = 48;
const MAX_HEIGHT = 900;
const DEFAULT_HEIGHT = 180;

/**
 * The MCP App of a tool call: the app's page, served by the studio with the CSP the app declared,
 * in a frame sandboxed with scripts only, so it never gets the studio's origin. The AppBridge tells
 * it the call's arguments and result, runs the tool calls it asks for, the ones its server marks
 * destructive once the person allowed them here, and sizes the frame as it asks
 */
export function ToolAppFrame({
  agent,
  call,
}: {
  agent: string;
  call: Pick<ToolCallRecord, 'name' | 'arguments' | 'result' | 'error'>;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const host = useRef<ToolAppHost>(undefined);
  const [info, setInfo] = useState<ToolAppFrameInfo>();
  const [failure, setFailure] = useState<string>();
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [pending, setPending] = useState<PendingAppCall>();
  const confirms = useRef<ConfirmQueue>(undefined);
  const tool = call.name;

  useEffect(() => {
    let live = true;
    api
      .toolApp(agent, tool)
      .then((found) => live && setInfo(found))
      .catch((error: unknown) => live && setFailure(messageOf(error)));
    return () => {
      live = false;
    };
  }, [agent, tool]);

  useLayoutEffect(() => {
    const target = frame.current?.contentWindow;
    if (!info || !target) return;
    const queue = createConfirmQueue(setPending);
    confirms.current = queue;
    const current = createToolAppHost({
      callTool: (name, args, approved) => api.callToolApp(agent, tool, name, args, approved),
      confirm: (name, args) => queue.ask(name, args),
      onSize: ({ height: asked }) => {
        if (asked !== undefined) setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, asked)));
      },
      openLink: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
      hostContext: {
        theme: resolvedTheme(),
        containerDimensions: { maxHeight: MAX_HEIGHT },
      },
    });
    host.current = current;
    void current.bridge
      .connect(new PostMessageTransport(target, target))
      .catch((error: unknown) => {
        setFailure(messageOf(error));
      });
    return () => {
      if (host.current === current) host.current = undefined;
      if (confirms.current === queue) confirms.current = undefined;
      queue.dispose();
      void current.close();
    };
  }, [info, agent, tool]);

  useEffect(() => {
    host.current?.show({ arguments: call.arguments, result: call.result, error: call.error });
  }, [info, call.arguments, call.result, call.error]);

  if (failure) {
    return (
      <div className="tool-app" data-testid="tool-app">
        <ErrorText>
          The app of {tool} did not load: {failure}
        </ErrorText>
      </div>
    );
  }
  if (!info) return null;

  return (
    <div
      className="tool-app"
      data-border={info.prefersBorder !== false}
      data-testid="tool-app"
      data-uri={info.uri}
    >
      <div className="tool-app-head">
        <AppWindow size={12} />
        <span className="truncate">{info.uri}</span>
      </div>
      <iframe
        ref={frame}
        title={`App of ${tool}`}
        src={toolAppUrl(agent, tool)}
        sandbox={TOOL_APP_SANDBOX}
        allow={appAllowAttribute(info.permissions) || undefined}
        referrerPolicy="no-referrer"
        style={{ height }}
        data-testid="tool-app-frame"
      />
      {pending && (
        <div className="approval" data-testid="tool-app-approval">
          <div className="approval-text">
            <ShieldAlert size={15} />
            The app asks to call {pending.name}
          </div>
          <pre className="tool-app-args">{pretty(pending.args)}</pre>
          <div className="approval-row">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => confirms.current?.answer(false)}
              data-testid="tool-app-deny"
            >
              Deny
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => confirms.current?.answer(true)}
              data-testid="tool-app-allow"
            >
              Allow
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
