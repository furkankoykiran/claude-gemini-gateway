# claude-gemini-gateway

Policy-safe Anthropic Messages to Google Gemini / Vertex AI gateway for Claude Code.

## Overview

`claude-gemini-gateway` runs as a lightweight local adapter that exposes an Anthropic Messages-compatible (`/v1/messages` and `/v1/models`) loopback HTTP endpoint. It translates requests and streaming Server-Sent Events (SSE) into Google Gemini Developer API or Vertex AI invocations.

## Security & Credential Boundary

- **Supported Credentials Only:** Supports official Google AI Studio (`GEMINI_API_KEY`) or Vertex AI credentials (`GOOGLE_APPLICATION_CREDENTIALS` / `ANTHROPIC_VERTEX_PROJECT_ID`).
- **Policy Safe:** Strictly rejects personal Antigravity consumer OAuth tokens. Consumer OAuth is never read, copied, refreshed, or proxied into Claude Code. When only consumer OAuth is detected, the gateway fails closed and directs users to native `agy` CLI usage.
- **Fail-Closed:** Missing or invalid credentials return structured 401/403 responses without fallback.

## Quick Start

```bash
# Start gateway
bin/gateway.sh start

# Status
bin/gateway.sh status

# Stop
bin/gateway.sh stop
```

## Running with Bun

```bash
bun run src/index.ts serve
```

## Environment Variables

- `GEMINI_API_KEY`: Official Google AI Studio API key.
- `GEMINI_GATEWAY_PORT`: Port to listen on (default: `4141`).
- `GEMINI_GATEWAY_HOST`: Host to bind to (default: `127.0.0.1`).
- `GEMINI_MODEL`: Default model to map to (default: `gemini-3.8-flash`).

## License

MIT
