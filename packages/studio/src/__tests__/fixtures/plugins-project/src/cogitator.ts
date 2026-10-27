import { Cogitator, experimental_definePlugin, tool } from '@cogitator-ai/core';
import { z } from 'zod';

let clicks = 0;
let flakyLoads = 0;

const BOARD_PAGE = `<!doctype html>
<html>
  <body>
    <button id="count">Count</button>
    <pre id="out"></pre>
    <script>
      let next = 0;
      const pending = new Map();
      window.addEventListener('message', (event) => {
        const data = event.data;
        if (!data || data.type !== 'cogitator:response' || !pending.has(data.id)) return;
        pending.get(data.id)(data);
        pending.delete(data.id);
      });
      function call(method, params) {
        return new Promise((resolve) => {
          const id = 'req-' + ++next;
          pending.set(id, resolve);
          window.parent.postMessage({ type: 'cogitator:request', id, method, params }, '*');
        });
      }
      document.getElementById('count').addEventListener('click', async () => {
        document.getElementById('out').textContent = JSON.stringify(await call('count', {}));
      });
    </script>
  </body>
</html>`;

const board = experimental_definePlugin({
  name: 'board',
  displayName: 'Board',
  version: '1.2.0',
  description: 'A board panel and a tool that writes on it',
  permissions: { allow: ['Read(./docs/**)'], deny: ['Bash(rm *)'] },
  activate(context) {
    context.registerTool(
      tool({
        name: 'board_note',
        description: 'Notes a line on the board',
        parameters: z.object({ line: z.string() }),
        execute: async ({ line }) => `noted ${line}`,
      })
    );
    context.registerPanel({
      id: 'main',
      title: 'Board',
      description: 'What the board holds',
      html: BOARD_PAGE,
      handlers: {
        echo: (params) => ({ echoed: params }),
        count: () => ({ clicks: ++clicks }),
        fail: () => {
          throw new Error('the board is closed');
        },
      },
    });
  },
});

const flaky = experimental_definePlugin({
  name: 'flaky',
  version: '0.1.0',
  description: 'Loads once and fails every reload',
  activate() {
    flakyLoads++;
    if (flakyLoads > 1) throw new Error(`flaky broke on load ${flakyLoads}`);
  },
});

const dormant = experimental_definePlugin({
  name: 'dormant',
  description: 'Off until it is enabled',
  activate(context) {
    context.registerCommand('wake', 'Wake up and say hello');
  },
});

export const cogitator = new Cogitator({
  experimental_plugins: {
    plugins: [board, flaky, dormant],
    enabled: { 'dormant@code': false },
    installed: false,
    settings: false,
  },
});

export const agents = {};
