---
'@cogitator-ai/bridge': minor
'@cogitator-ai/cli': minor
---

The agents of a bridge can be offered to the outside: as an A2A service and as the tools of an MCP server.

- `bridgeAgents()` from `@cogitator-ai/bridge/outward` returns the agents of the bridge with what runs them, in the shape `A2AServer` and `serveAgents` take. A message or a tool call becomes a job of the bridge, and the report of the agent is the answer.
- A question of the agent pauses the run like a question of a tool: an A2A task waits in `input-required` and the next message answers it. A tool call answers with the question and the thread to answer it on.
- A caller that gives up or moves on takes its job back, and so does a door that closes. Leave for a call is asked through the bridge, from the person at the machine, never from the caller.
- Each door is a session of its own in the book of the bridge, so two of them never read each other's mail.
- `waitForMail()` results have `release()`, which gives the letters up for the next waiter instead of confirming them.
- `cogitator bridge offer [agent...]` serves the agents as MCP tools on stdio, for the configuration of any MCP client.
