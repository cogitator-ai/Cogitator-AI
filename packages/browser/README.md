# @cogitator-ai/browser

Browser automation tools for Cogitator AI agents. Playwright-based with 32 tools across 5 modules, vision mode, stealth system, structured data extraction, and network control.

## Features

- **32 Browser Tools** across 5 modules (navigation, interaction, extraction, vision, network)
- **BrowserSession** -- managed browser lifecycle with tabs, cookies, proxy
- **Stealth Mode** -- fingerprint evasion, human-like typing/mouse, UA rotation
- **Vision Mode** -- screenshot + accessibility tree for vision LLM navigation
- **Smart Extraction** -- tables, structured data, links, clean text
- **Network Control** -- request interception, HAR capture, resource blocking, API monitoring
- **Playwright-powered** -- Chromium, Firefox, WebKit support

## Installation

```bash
pnpm add @cogitator-ai/browser playwright
```

## Quick Start

```typescript
import { BrowserSession, browserTools } from '@cogitator-ai/browser';
import { Agent, Cogitator } from '@cogitator-ai/core';

const session = new BrowserSession({ headless: true });
await session.start();

const agent = new Agent({
  name: 'web-researcher',
  model: 'gpt-4o',
  instructions: 'You browse the web and extract information.',
  tools: browserTools(session),
});

const cog = new Cogitator({ llm: { defaultProvider: 'openai' } });
const result = await cog.run(agent, {
  input: 'Go to https://news.ycombinator.com and get the top 5 story titles',
});

console.log(result.output);
await session.close();
```

## Tool Modules

### Navigation (7 tools)

| Tool                          | Description                                                  |
| ----------------------------- | ------------------------------------------------------------ |
| `browser_navigate`            | Navigate to a URL. Returns final URL, title, and HTTP status |
| `browser_go_back`             | Go back in browser history                                   |
| `browser_go_forward`          | Go forward in browser history                                |
| `browser_reload`              | Reload the current page                                      |
| `browser_wait_for_navigation` | Wait for navigation to a URL matching a pattern              |
| `browser_get_current_url`     | Get current page URL and title                               |
| `browser_wait_for_selector`   | Wait for a CSS selector to appear on the page                |

### Interaction (9 tools)

| Tool                    | Description                                                                       |
| ----------------------- | --------------------------------------------------------------------------------- |
| `browser_click`         | Click an element by CSS selector. Supports button, clickCount, position           |
| `browser_type`          | Type text into an input. Stealth mode adds human-like keystroke delays            |
| `browser_select_option` | Select from a `<select>` element by value, label, or index                        |
| `browser_hover`         | Hover over an element                                                             |
| `browser_scroll`        | Scroll the page or a specific element in any direction                            |
| `browser_press_key`     | Press a keyboard key with optional modifier keys                                  |
| `browser_drag_and_drop` | Drag an element onto another element                                              |
| `browser_fill_form`     | Smart form filler -- finds inputs by name, placeholder, aria-label, or label text |
| `browser_upload_file`   | Upload files to a file input element                                              |

### Extraction (7 tools)

| Tool                         | Description                                                        |
| ---------------------------- | ------------------------------------------------------------------ |
| `browser_get_text`           | Extract text from the page or a specific element                   |
| `browser_get_html`           | Get inner or outer HTML of the page or an element                  |
| `browser_get_attribute`      | Get the value of a DOM attribute                                   |
| `browser_get_links`          | Extract all links with text, href, and title                       |
| `browser_query_selector_all` | Query all matching elements with tag, text, attributes, visibility |
| `browser_extract_table`      | Extract structured data from HTML tables (headers + rows)          |
| `browser_extract_structured` | Extract clean readable text, stripping scripts/styles/SVG          |

### Vision (4 tools)

| Tool                           | Description                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `browser_screenshot`           | Screenshot the page or element. Returns base64 PNG/JPEG                                 |
| `browser_screenshot_element`   | Screenshot a specific element with bounding box coordinates                             |
| `browser_find_by_description`  | Find elements by natural language using the accessibility tree                          |
| `browser_click_by_description` | Click an element by natural language description (tries role, text, label, placeholder) |

### Network (5 tools)

| Tool                        | Description                                                          |
| --------------------------- | -------------------------------------------------------------------- |
| `browser_intercept_request` | Intercept HTTP requests -- block, modify, or continue by URL pattern |
| `browser_wait_for_response` | Wait for an HTTP response matching a URL pattern                     |
| `browser_block_resources`   | Block resource types (image, stylesheet, font, media, script)        |
| `browser_capture_har`       | Start/stop HAR traffic capture. Returns all captured entries on stop |
| `browser_get_api_calls`     | Get captured XHR/fetch calls, filtered by URL pattern or method      |

## Stealth Mode

Stealth mode makes the browser harder to detect as automated. It applies evasion scripts on context creation and enables human-like input simulation.

```typescript
const session = new BrowserSession({
  stealth: true, // enable all defaults
});

// or configure individually
const session = new BrowserSession({
  stealth: {
    humanLikeTyping: true, // random delays between keystrokes (50-150ms)
    humanLikeMouse: true, // bezier curve mouse movement
    fingerprintRandomization: true, // canvas/WebGL/plugin spoofing
    blockWebDriver: true, // navigator.webdriver = false
    evasionScripts: [], // custom init scripts to inject
  },
});
```

What stealth mode does:

- Sets `navigator.webdriver` to `false`
- Spoofs `navigator.plugins` with realistic Chrome plugins
- Sets `navigator.languages` to `['en-US', 'en']`
- Randomizes canvas fingerprint (1-bit pixel noise)
- Spoofs WebGL vendor/renderer (Intel Iris)
- Injects `window.chrome` runtime stubs
- Overrides `Permissions.query` for notifications
- Rotates User-Agent strings per browser type
- Adds human-like typing delays (50-150ms per character)
- Uses bezier curve mouse movement for clicks

## Vision Mode

Vision tools let agents interact with pages using natural language instead of CSS selectors:

```typescript
import { BrowserSession, browserTools } from '@cogitator-ai/browser';

const session = new BrowserSession();
await session.start();

const tools = browserTools(session, { modules: ['navigation', 'vision'] });

// Agent can now use:
// browser_screenshot -- take a screenshot for visual analysis
// browser_find_by_description -- "find the login button"
// browser_click_by_description -- "click the Submit button"
```

`browser_find_by_description` walks the accessibility tree and matches elements by role and name against the description. `browser_click_by_description` tries multiple strategies: role button, role link, text content, label, and placeholder.

## Network Control

```typescript
import { BrowserSession, createNavigationTools, createNetworkTools } from '@cogitator-ai/browser';

const session = new BrowserSession();
await session.start();

const tools = [...createNavigationTools(session), ...createNetworkTools(session)];

// Agent can intercept requests:
// browser_intercept_request({ urlPattern: "**/ads/**", action: "block" })

// Block resource types to speed up loading:
// browser_block_resources({ types: ["image", "font", "stylesheet"] })

// Monitor API calls made by the page:
// browser_get_api_calls({ urlPattern: "/api/", method: "POST" })

// Capture HAR traffic:
// browser_capture_har({ action: "start" })
// ... navigate and interact ...
// browser_capture_har({ action: "stop", path: "./traffic.har" })
```

## BrowserSession API

### Constructor

```typescript
const session = new BrowserSession(config?: BrowserSessionConfig);
```

### BrowserSessionConfig

```typescript
interface BrowserSessionConfig {
  headless?: boolean; // default: true
  browser?: 'chromium' | 'firefox' | 'webkit'; // default: 'chromium'
  stealth?: boolean | StealthConfig; // enable stealth mode
  proxy?: string | ProxyConfig; // proxy server
  viewport?: { width: number; height: number }; // default: 1280x720
  userAgent?: string; // custom UA (stealth rotates automatically)
  locale?: string; // browser locale (e.g., 'en-US')
  timezone?: string; // timezone ID (e.g., 'America/New_York')
  geolocation?: { latitude: number; longitude: number };
  cookies?: BrowserCookie[]; // pre-load cookies
  timeout?: number; // navigation timeout, default: 30000ms
  actionTimeout?: number; // action timeout, default: 10000ms
}
```

### Lifecycle

```typescript
await session.start(); // launch browser, create context and first page
await session.close(); // close browser and cleanup
```

### Properties

```typescript
session.page; // active Playwright Page
session.tabs; // all open Page[]
session.browser; // Playwright Browser instance
session.context; // Playwright BrowserContext
session.config; // current config
session.stealthEnabled; // whether stealth is on
session.stealthConfig; // resolved StealthConfig or null
```

### Tab Management

```typescript
const page = await session.newTab('https://example.com'); // open new tab
session.switchTab(1); // switch to tab by index
await session.closeTab(0); // close tab by index
```

### Cookie Management

```typescript
const cookies = await session.getCookies();
await session.setCookies([{ name: 'token', value: 'abc', domain: '.example.com' }]);
await session.saveCookies('./cookies.json');
await session.loadCookies('./cookies.json');
```

## Module Selection

Load only the tool modules you need:

```typescript
// all 32 tools
const tools = browserTools(session);

// only navigation + extraction (14 tools)
const tools = browserTools(session, {
  modules: ['navigation', 'extraction'],
});

// or use individual factory functions
import {
  createNavigationTools,
  createExtractionTools,
  createScreenshotTool,
} from '@cogitator-ai/browser';

const tools = [
  ...createNavigationTools(session),
  ...createExtractionTools(session),
  createScreenshotTool(session),
];
```

Available modules: `navigation`, `interaction`, `extraction`, `vision`, `network`.

## Utility Helpers

Standalone helpers for advanced use cases:

```typescript
import {
  smartSelect,
  findFormField,
  getReadableText,
  getAccessibilityTree,
  elementToInfo,
} from '@cogitator-ai/browser';

// smartSelect tries CSS, XPath, then text matching
const locator = await smartSelect(page, 'Submit');

// findFormField tries name, placeholder, aria-label, label text
const input = await findFormField(page, 'Email');

// getReadableText strips scripts/styles and returns clean text
const text = await getReadableText(page);

// getAccessibilityTree returns simplified a11y tree
const tree = await getAccessibilityTree(page);
```

## Stealth Standalone Functions

Use stealth primitives directly outside of BrowserSession:

```typescript
import {
  humanLikeType,
  humanLikeClick,
  humanLikeScroll,
  getRandomUserAgent,
  getAllUserAgents,
  getEvasionScripts,
  applyStealthToContext,
  getStealthLaunchOptions,
} from '@cogitator-ai/browser';

// human-like input on any Playwright page
await humanLikeType(page, '#search', 'cogitator ai');
await humanLikeClick(page, '.submit-btn');
await humanLikeScroll(page, 'down', 500);

// get a random UA for a browser type
const ua = getRandomUserAgent('chromium');
```

## License

MIT
