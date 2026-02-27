# Device Tools

Example tools for controlling the host machine from your AI assistant.

## Tools

| Tool              | Description                     | macOS                     | Linux                  |
| ----------------- | ------------------------------- | ------------------------- | ---------------------- |
| `screenshot`      | Capture screen/window/selection | `screencapture`           | `import` (ImageMagick) |
| `read_clipboard`  | Read clipboard text             | `pbpaste`                 | `xclip`                |
| `write_clipboard` | Write to clipboard              | `pbcopy`                  | `xclip`                |
| `notify`          | System notification             | `osascript`               | `notify-send`          |
| `open_url`        | Open URL in browser             | `open`                    | `xdg-open`             |
| `shell_exec`      | Run safe shell commands         | Allowlisted commands only |

## Usage as individual tools

```ts
import { Agent } from '@cogitator-ai/core';
import { screenshotTool } from './01-screenshot.js';
import { notifyTool } from './03-notify.js';

const agent = new Agent({
  name: 'assistant',
  model: 'anthropic/claude-sonnet-4-20250514',
  tools: [screenshotTool, notifyTool],
});
```

## Usage as a skill

```ts
import { Agent } from '@cogitator-ai/core';
import deviceSkill from './skill.js';

const agent = new Agent({
  name: 'assistant',
  model: 'anthropic/claude-sonnet-4-20250514',
  skills: [deviceSkill],
});
```

## Security

- `shell_exec` only allows a predefined set of read-only commands
- No pipes, chaining, or subshells allowed
- Screenshots require user confirmation in the agent instructions
- All tools are macOS/Linux only
