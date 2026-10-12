# Gateway contract

## Shared authority

The latest non-system message must be a user turn. Actionable current text takes priority over historical tool results, including merged result/text blocks. Reminder-only input cannot infer. A result-only request must match a complete, outstanding cycle in the same Claude session; duplicate, stale, cross-session and incomplete results fail closed.

Only runtime-declared tools and schemas are authoritative. Claude Code executes the tool, applies hooks and permissions, owns MCP, and supplies the actual result or failure. The gateway never acknowledges a successful tool call before receiving that result. Model catalogs and health are not proof of execution access.

## Cleanup

`PROVIDER_GATEWAY_TIMEOUT_MS` (replace PROVIDER with CODEX or GEMINI) is a positive integer in milliseconds, default 300000. It bounds transport waits and outstanding Claude tool cycles. Timeout, cancellation, shutdown or terminal provider failure invalidates the origin. Late results cannot restart it. Restarting loses ephemeral correlation state and rejects subsequent results.

SSE tool inputs start with `{}` and are delivered as `input_json_delta`. Both gateways buffer a provider response before returning Anthropic SSE; they do not promise token-by-token latency. Errors are structured and cannot produce a successful terminal message. Default diagnostics do not log request bodies. Loopback callers are trusted local clients; the HTTP service is not a public authenticated API.

## Gemini adapter

`src/translate.ts` owns Google message conversion, `src/contract.ts` owns current-turn validation and ephemeral issued-tool cycles, `src/auth.ts` owns credential classification, and `src/server.ts` owns HTTP transport. Google HTTP is stateless: no artificial app-server thread IDs are introduced. A cycle binds issued tool IDs, original arguments, session, model, and opaque provider function-call parts. Claiming all results is atomic before provider traffic; duplicates cannot replay it.

`GEMINI_GATEWAY_CONFIG` optionally reads a JSON file containing string-valued `env` settings; process environment overrides the file without mutating it. Use GEMINI_GATEWAY_MODEL (GEMINI_MODEL remains an alias) or an explicit Google request model. Claude aliases are rejected without configuration. Developer API model discovery uses Google's live list; Vertex advertises only the configured model and labels discovery configured-only. Catalog presence does not prove entitlement.

Supported authentication is GEMINI_API_KEY or an explicit Vertex project plus GOOGLE_OAUTH_TOKEN supplied as an official Google Cloud access token. GOOGLE_APPLICATION_CREDENTIALS alone is rejected: ADC loading/refresh is not implemented. Consumer Antigravity OAuth is never read/copied/refreshed. API keys travel in headers, not URLs. Errors suppress upstream bodies to avoid credential/prompt leakage.

Google function-call parts, including opaque thought signatures, are preserved for the matched continuation rather than fabricated. See Google's [function calling](https://ai.google.dev/gemini-api/docs/function-calling) and [thought signature](https://ai.google.dev/gemini-api/docs/thought-signatures) documentation. Multi-hop signed history beyond the pending cycle, model-specific schema subsets, multimodal content and broad MCP parity remain unproven. Unsupported input blocks fail closed. Malformed/truncated streams, missing terminal candidates and safety-blocked responses fail closed.
