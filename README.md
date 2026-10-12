# claude-gemini-gateway

Anthropic Messages-compatible Google inference adapters for Claude Code. Part of the gateway family with [claude-codex-gateway](https://github.com/furkankoykiran/claude-codex-gateway).

## Status and ownership

Experimental protocol subset. Claude Code owns MCP, hooks, permissions and tool execution; the provider supplies inference. Health, catalogs and fixture tests do not prove live access or broad parity. See [the contract](docs/contract.md) and [verification](docs/verification.md) for tested behavior and limitations.

## Architecture

Claude Code -> local Anthropic Messages adapter -> official local AGY CLI, Gemini Developer API, or Vertex HTTP. Adapter selection is explicit: `agy-cli`, `gemini-api`, or `vertex`. Tool results return through Claude Code and are correlated to the exact pending origin. See [architecture decisions](docs/architecture.md).

## Development and setup

Requires Bun 1.3.8 or newer. For `agy-cli`, install and sign in with the official `agy` CLI; its native session remains entirely with AGY. No Gemini API key is required. For `gemini-api`/`vertex`, set an official Google AI Studio API key (`GEMINI_API_KEY`), or a Vertex project and official Google Cloud access token (`GOOGLE_OAUTH_TOKEN`). ADC files alone are unsupported. API adapters never reuse AGY authentication.

```bash
bun install --frozen-lockfile
# API: configure credentials and GEMINI_GATEWAY_MODEL from your provider catalog.
# Native CLI: export GEMINI_GATEWAY_ADAPTER=agy-cli
# Optional AGY_GATEWAY_MODEL comes from: agy models
bun run src/index.ts preflight
bun run src/index.ts serve
```

Point Claude Code at `http://127.0.0.1:4141` using an explicit local settings override. Configure its model for your provider. Do not copy OAuth tokens or change Claude Code's tool permission boundaries.

## Configuration

| Variable | Meaning |
| --- | --- |
| GEMINI_GATEWAY_ADAPTER | `agy-cli`, `gemini-api`, or `vertex`; omitted selects API credentials for compatibility |
| AGY_GATEWAY_BIN | Official executable from PATH (`agy`) or configured path |
| AGY_GATEWAY_MODEL / AGY_GATEWAY_EFFORT | Optional native model/effort; configured model wins, otherwise explicit request model is honored; frontend alias delegates to AGY |
| AGY_GATEWAY_WORKSPACE_ROOT | Existing directory for disposable guarded native workspaces; defaults to OS temp |
| GEMINI_GATEWAY_API_BASE_URL | Optional API/Vertex base URL, including API version, for configured transports |
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

`bin/gateway.sh start`, `status`, `doctor`, and `stop` manage a local daemon. `GET /health` and `/healthz` report gateway/version/configuration; `GET /v1/models` reports provider catalog information; `POST /v1/messages` translates inference. `preflight` requires a real nonce inference reply before reporting authenticated. A healthy process is not inference entitlement. Native stdout is validated and stderr is suppressed; use the official CLI directly to diagnose native authentication. Restarting invalidates pending tool cycles.

## Verification

```bash
bun run lint
bun run typecheck
bun run test
```

The canonical test command is `bun run test` (`bun test tests`). Gateway CI runs these checks after frozen installation. Use disposable state directories for lifecycle tests and port zero for HTTP fixtures. Record live provider and Claude-owned tool acceptance separately.

## Native AGY boundary

Each request creates an isolated native conversation and workspace. A mandatory wildcard native `PreToolUse` hook denies execution; a `PreInvocation` acknowledgement must match the conversation. These are transport guards, not copies of Claude hooks. Any native tool/delegation event fails the request. Claude tools are proposed as JSON data and their actual results return as text context; AGY does not accept a native external tool-result RPC. Fresh user text wins, pending tool IDs are single-use, and cancellation kills only the spawned process tree. The adapter is experimental; catalog/health/preflight do not prove Claude-owned MCP cycles or broad parity.

## Community and security

See [CONTRIBUTING](CONTRIBUTING.md), [SECURITY](SECURITY.md), and [CODE_OF_CONDUCT](CODE_OF_CONDUCT.md). Licensed under [MIT](LICENSE).
