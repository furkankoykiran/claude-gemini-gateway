# Verification

The initial adapter had nine passing translation/auth tests; HTTP setup could not bind its fixed port in the sandbox. Tests now use OS-assigned ports and an injectable fixture transport.

Frozen Bun installation, shell syntax lint, typecheck, and 28 tests (105 assertions) passed with loopback listener access. Fixtures cover current-turn authority, actual success/failure results, session/model matching, atomic multi-tool claims, expiry, cancellation, provider failures, opaque signatures and fragmented SSE. Gateway CI repeats the documented checks.

No supported Google API or Vertex credentials were present in this session. Live Gemini inference, actual Claude-owned Gemini MCP execution, Vertex entitlement, ADC loading/refresh and model-specific tool/schema compatibility remain unproven. Missing credentials and consumer OAuth are rejected. No credentials were copied or invented to bypass that boundary.

ShellCheck passed for both family lifecycle scripts. Disposable state tests rejected an unrelated PID on start, status and stop without terminating it. No npm or update-distribution behavior was changed.

## AGY adapter wave

Frozen install, lint, typecheck and 38 tests (121 assertions) passed. New fixtures prove missing/unauthenticated CLI rejection, protocol corruption, foreign conversation IDs, native execution rejection, duplicate terminal data, cancellation, distinct adapters, API credential rejection and a declared external tool/result/fresh-turn cycle. Live official AGY 1.3.3 returned the exact new nonce with a runtime-discovered model; its native PreInvocation guard acknowledgement matched the conversation. A separate native negative probe attempted a disposable write: PreToolUse denied it and no file appeared. No credentials or native session files were copied.

Claude Code text and tool/MCP acceptance through the parent canonical command will be recorded after routing lands. Until then, the native nonce proves only this transport path. API/Vertex live entitlement remains unproven without supported credentials. The optional CLI schema mode is not required: NDJSON result.response must contain a strict JSON envelope. Unknown native step types fail closed rather than implying support.
