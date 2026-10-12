# REA connector for Claude

Use REA as a **custom connector** in Claude (web, desktop and mobile) or any
client that speaks remote MCP.

REA's own server speaks MCP over stdio, which only local agents can launch.
Claude connectors call a URL from Anthropic's cloud, so this folder adds a small
bridge that serves REA over **MCP Streamable HTTP**:

```
Claude (cloud) ──HTTPS──▶ tunnel ──▶ rea-connector.mjs (your machine) ──stdio──▶ rea mcp
```

Analysis still runs on **your** machine, against your local files, Hopper,
Ghidra or IDA — exactly as with a local agent. The bridge has no dependencies
beyond Node.js and does not modify REA itself.

## Quick start

From the root of this repository, on the machine that holds your targets:

```bash
brew install cloudflared        # or see developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
./connector/start.sh
```

On first run the script builds REA, generates a token in
`~/.config/rea-connector/token`, starts the bridge and opens a Cloudflare quick
tunnel. It prints two things you need:

- the connector URL, e.g. `https://random-words.trycloudflare.com/mcp`
- the header, `Authorization: Bearer <token>`

## Add it to Claude

1. In Claude, open **Settings → Connectors → Add custom connector**.
2. Name: `REA`. URL: the `…/mcp` URL from the script.
3. Under **Authentication**, choose no sign-in. Under **Request headers**, add
   `Authorization` with the value `Bearer <token>`.
4. Save, then enable REA in a conversation from the tools menu.

Try: _"Use REA to analyze the JavaScript app at /Applications/Foo.app/Contents/Resources/app.asar and explain how its search works."_

## Keep a stable URL

Quick-tunnel URLs change every restart, which means editing the connector each
time. For a permanent URL, create a named tunnel on a domain you control:

```bash
cloudflared tunnel login
cloudflared tunnel create rea
cloudflared tunnel route dns rea rea.yourdomain.com
CLOUDFLARE_TUNNEL=rea ./connector/start.sh
```

Any other tunnel or reverse proxy works too (Tailscale Funnel, ngrok, Caddy).
Run `./connector/start.sh --local` to start only the bridge on `127.0.0.1:8787`.

## Security

REA reads files and can launch processes on the host, so treat the token like
an SSH key.

- The bridge refuses to start without a token and compares it in constant time.
- It listens on `127.0.0.1` only; the tunnel is the sole public entry point.
- Requests with a browser `Origin` other than localhost are rejected.
- Stop the script (Ctrl-C) whenever you don't need the connector. To rotate the
  token, delete `~/.config/rea-connector/token`, restart, and update the header
  in Claude.
- For extra protection, put Cloudflare Access in front of a named tunnel and
  allow only [Anthropic's IP ranges](https://platform.claude.com/docs/en/api/ip-addresses).

## Configuration

| Variable                        | Default                                            | Purpose                                                                                 |
| ------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `REA_CONNECTOR_TOKEN`           | from token file                                    | Bearer token clients must send                                                          |
| `REA_CONNECTOR_PORT`            | `8787`                                             | Listen port                                                                             |
| `REA_CONNECTOR_HOST`            | `127.0.0.1`                                        | Listen address                                                                          |
| `REA_CONNECTOR_PATH`            | `/mcp`                                             | MCP endpoint path                                                                       |
| `REA_COMMAND`                   | this checkout, else `npx -y rea-agents@latest mcp` | Command that starts REA over stdio                                                      |
| `REA_CONNECTOR_MAX_SESSIONS`    | `4`                                                | Concurrent sessions (one REA process each); least recently used idle session is evicted |
| `REA_CONNECTOR_IDLE_MINUTES`    | `30`                                               | Idle sessions are closed after this                                                     |
| `REA_CONNECTOR_MAX_BODY_MB`     | `8`                                                | Maximum request size                                                                    |
| `REA_CONNECTOR_ALLOWED_ORIGINS` | none                                               | Extra browser origins to allow, comma-separated                                         |

`GET /healthz` returns `{ ok, sessions }` without authentication.

## How it works

- Each MCP session (`initialize`) spawns its own `rea mcp` process, so
  conversations don't share state. `DELETE` or the idle timeout stops it.
- Requests are answered as Server-Sent Events, so progress notifications reach
  Claude while long analyses run; a heartbeat keeps tunnels from timing out.
  Clients that don't accept SSE get plain JSON.
- If the client disconnects mid-request, the bridge sends REA a cancellation.

## Test it

```bash
REA_CONNECTOR_TOKEN=$(cat ~/.config/rea-connector/token) node connector/smoke-test.mjs
# or against the tunnel:
REA_CONNECTOR_URL=https://…/mcp REA_CONNECTOR_TOKEN=… node connector/smoke-test.mjs
```

The smoke test checks auth, initialization, `tools/list`, a static JavaScript
analysis (needs no native engine) and session teardown.
