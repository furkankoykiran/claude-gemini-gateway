# Verification

The initial adapter had nine passing translation/auth tests; HTTP setup could not bind its fixed port in the sandbox. Tests now use OS-assigned ports and an injectable fixture transport.

Frozen Bun installation, shell syntax lint, typecheck, and 28 tests (105 assertions) passed with loopback listener access. Fixtures cover current-turn authority, actual success/failure results, session/model matching, atomic multi-tool claims, expiry, cancellation, provider failures, opaque signatures and fragmented SSE. Gateway CI repeats the documented checks.

No supported Google API or Vertex credentials were present in this session. Live Gemini inference, actual Claude-owned Gemini MCP execution, Vertex entitlement, ADC loading/refresh and model-specific tool/schema compatibility remain unproven. Missing credentials and consumer OAuth are rejected. No credentials were copied or invented to bypass that boundary.

ShellCheck passed for both family lifecycle scripts. Disposable state tests rejected an unrelated PID on start, status and stop without terminating it. No npm or update-distribution behavior was changed.
