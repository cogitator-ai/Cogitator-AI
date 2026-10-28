---
'@cogitator-ai/mcp': minor
'@cogitator-ai/types': minor
'@cogitator-ai/core': minor
'@cogitator-ai/studio': minor
---

MCP Apps (extension `io.modelcontextprotocol/ui`): tools come with interactive `ui://` pages, our MCP server serves them, the client reads them, and Studio renders them.

Server:

- A tool's new `app` field names its MCP App. `mcpApp({ uri, html, csp?, permissions?, domain?, prefersBorder?, visibility? })` builds one for a tool this process serves, and an `MCPServer` that serves the tool lists it with `_meta.ui.resourceUri` (and the older flat `_meta['ui/resourceUri']`), serves the page as a resource of type `text/html;profile=mcp-app` with `_meta.ui` on the listing and the content, and declares the extension in its capabilities.
- `server.registerApp(config)` serves an app on its own and `server.getRegisteredApps()` lists the URIs served. `serveAgents` takes `apps`, an app per agent, for the agent's tool.
- A tool with `visibility: ['app']` is for its page only.

Client:

- `MCPClient` tells servers it takes apps (`apps: false` turns it off). A wrapped tool of a server that points at an app carries it as `tool.app`: `read()` gives the page with its CSP, permissions, domain and border preference, `callTool(name, args)` calls a tool of the same server for the page (only a tool open to apps), `requiresApproval(name)` says whether that tool is destructive.
- `getTools()` leaves out the tools a server opens to apps only, as MCP Apps asks of a host. `getToolApp(name)`, `readApp(uri)` and `callToolForApp(name, args)` do the same by hand.
- `@modelcontextprotocol/ext-apps` 2.0.4 is a new dependency of `@cogitator-ai/mcp`.

Studio:

- A tool call whose tool has an app shows the app under it, in the chat and on the run page. The studio serves the page from its own address, sandboxed with `allow-scripts` only so it runs with an opaque origin, and with a Content-Security-Policy built from the origins the app declares and a Permissions-Policy that grants the features it asked for and nothing else.
- The studio is the app's host through the ext-apps `AppBridge`: it sends the call's arguments and result (or that it failed), sizes the frame and opens web links in a new tab. Tool calls the app makes go to its server, and a destructive one waits for the person to press **Allow** in the card.
- New routes: `GET /api/agents/:agent/tools/:tool/app`, `GET .../app/view` and `POST .../app/call`.
- A web host is asked to put a sandbox proxy on an origin of its own between itself and the app. Studio gets the same isolation from the app's frame with an opaque origin and a header policy the page cannot change. A dedicated `domain` an app asks for is not honored.
