# claude-gemini-gateway

Anthropic Messages-compatible Gemini inference adapter for Claude Code. Part of the gateway family with [claude-codex-gateway](https://github.com/furkankoykiran/claude-codex-gateway).

## Status and ownership

Experimental protocol subset. Claude Code owns MCP, hooks, permissions and tool execution; the provider supplies inference. Health, catalogs and fixture tests do not prove live access or broad parity. See [the contract](docs/contract.md) and [verification](docs/verification.md) for tested behavior and limitations.

## Architecture

Claude Code -> local Anthropic Messages adapter -> Google Developer API or Vertex HTTP. Tool results return through Claude Code and are correlated to the exact pending origin. See [architecture decisions](docs/architecture.md).

## Development and setup

Requires Bun 1.3.8 or newer. Set an official Google AI Studio API key (`GEMINI_API_KEY`), or a Vertex project and official Google Cloud access token (`GOOGLE_OAUTH_TOKEN`). ADC files alone and personal Antigravity OAuth are unsupported and fail closed.

```bash
bun install --frozen-lockfile
# Set GEMINI_GATEWAY_MODEL to your available provider model.
bun run src/index.ts serve
```

Point Claude Code at `http://127.0.0.1:4141` using an explicit local settings override. Configure its model for your provider. Do not copy OAuth tokens or change Claude Code's tool permission boundaries.

## Configuration

| Variable | Meaning |
| --- | --- |
| GEMINI_GATEWAY_CONFIG | Optional JSON file with string-valued env configuration; process environment wins |
| GEMINI_GATEWAY_MODEL / GEMINI_MODEL | Explicit Google model; no Claude alias mapping |
| GEMINI_GATEWAY_PORT | Loopback port, default 4141 |
| GEMINI_GATEWAY_HOST | Loopback address only, default 127.0.0.1 |
| GEMINI_GATEWAY_TIMEOUT_MS | HTTP/tool cycle deadline, default 300000 ms |
| GEMINI_GATEWAY_STATE_DIR | Lifecycle state directory; defaults under HOME |
| GEMINI_API_KEY | Official Developer API key |
| VERTEX_PROJECT_ID / GOOGLE_CLOUD_PROJECT / ANTHROPIC_VERTEX_PROJECT_ID | Explicit Google Cloud project |
| VERTEX_LOCATION / CLOUD_ML_REGION | Google Cloud region, default us-central1 |
| GOOGLE_OAUTH_TOKEN | Official Google Cloud access token for Vertex; caller owns refresh |

## Diagnostics and lifecycle

`bin/gateway.sh start`, `status`, `doctor`, and `stop` manage a local daemon. `GET /health` and `/healthz` report gateway/version/configuration; `GET /v1/models` reports provider catalog information; `POST /v1/messages` translates inference. A healthy process is not inference entitlement. Restarting invalidates pending tool cycles.

## Verification

```bash
bun run lint
bun run typecheck
bun run test
```

The canonical test command is `bun run test` (`bun test tests`). Gateway CI runs these checks after frozen installation. Use disposable state directories for lifecycle tests and port zero for HTTP fixtures. Record live provider and Claude-owned tool acceptance separately.

## Community and security

See [CONTRIBUTING](CONTRIBUTING.md), [SECURITY](SECURITY.md), and [CODE_OF_CONDUCT](CODE_OF_CONDUCT.md). Licensed under [MIT](LICENSE).
