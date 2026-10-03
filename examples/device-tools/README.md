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
  model: 'anthropic/claude-sonnet-5-5',
  tools: [screenshotTool, notifyTool],
});
```

## Usage as a skill

```ts
import { Agent } from '@cogitator-ai/core';
import deviceSkill from './skill.js';

const agent = new Agent({
  name: 'assistant',
  model: 'anthropic/claude-sonnet-5-5',
  skills: [deviceSkill],
});
```

## Security

- No tool goes through a shell: every command runs with `execFile` and the model's input is passed as arguments, so quotes, pipes, redirects and `$(...)` are inert
- `shell_exec` only allows a predefined set of read-only commands (no `env`, `find`, `curl` or `wget`, which could leak secrets, delete files or send data out)
- `open_url` accepts only `http(s)` URLs, and `screenshot` filenames are limited to letters, digits, `-` and `_`
- Screenshots require user confirmation in the agent instructions
- All tools are macOS/Linux only
