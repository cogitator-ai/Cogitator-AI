# @cogitator-ai/browser

Browser automation tools for Cogitator AI agents. Playwright-based with 33 tools across 5 modules, vision mode, stealth system, structured data extraction, and network control.

## Features

- **33 Browser Tools** across 5 modules (navigation, interaction, extraction, vision, network)
- **BrowserSession** -- managed browser lifecycle with tabs (including popups), cookies, proxy, persistent profiles, and a tab limit
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
| `browser_type`          | Type text into an input. Stealth mode replaces the value with human-like keys     |
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
| `browser_get_text`           | Extract rendered text from the page or the first matching element  |
| `browser_get_html`           | Get inner or outer HTML of the page or an element                  |
| `browser_get_attribute`      | Get the value of a DOM attribute                                   |
| `browser_get_links`          | Extract all links with text, href, and title                       |
| `browser_query_selector_all` | Query all matching elements with tag, text, attributes, visibility |
| `browser_extract_table`      | Extract headers + rows from a table (or the first table inside)    |
| `browser_extract_structured` | Extract rendered text, without scripts/styles/hidden elements      |

### Vision (4 tools)

| Tool                           | Description                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `browser_screenshot`           | Screenshot the page or element. Returns base64 PNG/JPEG with `mimeType` and dimensions  |
| `browser_screenshot_element`   | Screenshot a specific element with bounding box coordinates                             |
| `browser_find_by_description`  | Find elements by natural language using the accessibility tree                          |
| `browser_click_by_description` | Click an element by natural language description (tries role, text, label, placeholder) |

### Network (6 tools)

| Tool                         | Description                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `browser_intercept_request`  | Block, modify, or continue requests matching a glob or `/regex/flags` in all tabs     |
| `browser_remove_interceptor` | Remove one interceptor by ID, or all of them                                          |
| `browser_wait_for_response`  | Wait for a response whose URL contains a substring or matches `/regex/flags`          |
| `browser_block_resources`    | Block resource types (image, stylesheet, font, media, script) in all tabs             |
| `browser_capture_har`        | Start/stop traffic capture of all tabs; on stop returns entries and can write HAR 1.2 |
| `browser_get_api_calls`      | XHR/fetch calls recorded since session start, filtered by URL or method; `clear`      |

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

Options you omit fall back to the defaults above (all `true`), so `stealth: { humanLikeMouse: false }` keeps every other feature enabled.

What stealth mode does:

- Sets `navigator.webdriver` to `false` (patched on `Navigator.prototype`, not as an own property)
- Spoofs `navigator.plugins` with realistic Chrome plugins
- Sets `navigator.languages` from `locale` (e.g. `de-DE` -> `['de-DE', 'de']`, default `['en-US', 'en']`)
- Aligns `navigator.platform` and `navigator.userAgentData.platform` with the user agent in use
- Randomizes canvas fingerprint (1-bit pixel noise)
- Spoofs WebGL vendor/renderer (Intel Iris)
- Injects `window.chrome` runtime stubs
- Overrides `Permissions.query` for notifications
- Rotates desktop User-Agent strings per browser type
- Adds human-like typing delays (50-150ms per character)
- Moves the mouse along bezier curves for `browser_click`, `browser_click_by_description`, `browser_hover`, and wheels in small steps for `browser_scroll`

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

// Agent can intercept requests (glob or /regex/flags), in every tab:
// browser_intercept_request({ urlPattern: "**/ads/**", action: "block" })
// browser_intercept_request({ urlPattern: "/\\.(png|jpe?g)$/i", action: "block" })
// browser_remove_interceptor({ interceptorId: "interceptor_1" })

// Block resource types to speed up loading:
// browser_block_resources({ types: ["image", "font", "stylesheet"] })

// Monitor API calls made by the page since the session started:
// browser_get_api_calls({ urlPattern: "/api/", method: "POST", clear: true })

// Capture traffic and save a HAR 1.2 file (path must be inside the working directory):
// browser_capture_har({ action: "start" })
// ... navigate and interact ...
// browser_capture_har({ action: "stop", path: "./traffic.har" })
```

Interceptors are registered on the browser context, so they also apply to tabs opened later. `continue` and `modify` hand the request to the next matching interceptor (`route.fallback`), so blocking rules keep working when several interceptors overlap. `modify.headers` are merged into the original request headers. API call history keeps the latest 1000 calls; HAR capture keeps up to 5000 entries and stores bodies only for textual responses up to 1 MB.

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
  persistentContext?: string; // user data dir; profile (cookies, storage) survives restarts
  cookies?: BrowserCookie[]; // pre-load cookies (domain cookies default to path '/')
  timeout?: number; // navigation timeout, default: 30000ms
  actionTimeout?: number; // action timeout, default: 10000ms
  pool?: { maxPages: number }; // maximum number of open tabs for newTab()
}
```

### Lifecycle

```typescript
await session.start(); // launch browser, create context and first page
await session.ensureStarted(); // start once; concurrent callers share one launch
await session.close(); // close browser and cleanup

const unsubscribe = session.onStart((context) => {
  // runs after every successful start (immediately if already started)
});
```

If the browser or context closes unexpectedly, the session resets itself and the next `ensureStarted()` (called by every tool from `browserTools`) relaunches it. A failed start closes anything it launched.

### Properties

```typescript
session.page; // active Playwright Page
session.tabs; // all open Page[] (includes popups and target=_blank pages)
session.activeTabIndex; // index of the active tab
session.started; // whether a context is running
session.browser; // Playwright Browser instance
session.context; // Playwright BrowserContext
session.config; // current config
session.stealthEnabled; // whether stealth is on
session.stealthConfig; // resolved StealthConfig or null
```

### Tab Management

```typescript
const page = await session.newTab('https://example.com'); // open new tab (respects pool.maxPages)
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
// all 33 tools
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

// getReadableText returns rendered text (no scripts, styles, or hidden elements)
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
  humanLikeHover,
  humanLikeScroll,
  getRandomUserAgent,
  getAllUserAgents,
  getEvasionScripts,
  applyStealthToContext,
  getStealthLaunchOptions,
} from '@cogitator-ai/browser';

// human-like input on any Playwright page
await humanLikeType(page, '#search', 'cogitator ai');
await humanLikeClick(page, '.submit-btn'); // selector or Locator
await humanLikeClick(page, page.getByRole('button', { name: 'Buy' }), { clickCount: 2 });
await humanLikeHover(page, '#menu');
await humanLikeScroll(page, 'down', 500); // up | down | left | right

// get a random desktop UA for a browser type
const ua = getRandomUserAgent('chromium');

// evasion scripts consistent with that user agent and locale
const scripts = getEvasionScripts({ userAgent: ua, locale: 'de-DE' });
await applyStealthToContext(context, { blockWebDriver: true }, { userAgent: ua, locale: 'de-DE' });
```

## License

MIT
