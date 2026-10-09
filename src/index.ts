import { createGatewayServer } from "./server.ts";
import { resolveGoogleCredentials, detectConsumerOAuth } from "./auth.ts";

export * from "./types.ts";
export * from "./auth.ts";
export * from "./translate.ts";
export * from "./server.ts";

const cmd = process.argv[2] ?? "serve";

if (import.meta.main) {
  if (cmd === "serve" || cmd === "start") {
    const port = Number(process.env["GEMINI_GATEWAY_PORT"] || 4141);
    const host = process.env["GEMINI_GATEWAY_HOST"] || "127.0.0.1";
    const server = createGatewayServer({ port, host });
    console.log(`[claude-gemini-gateway] listening on http://${host}:${server.port}`);
  } else if (cmd === "doctor") {
    console.log("[claude-gemini-gateway] environment doctor:");
    try {
      const creds = resolveGoogleCredentials();
      console.log(`  ✓ Auth: valid (${creds.kind})`);
    } catch (e: any) {
      console.log(`  ✗ Auth: ${e.message}`);
    }
    const hasConsumer = detectConsumerOAuth();
    console.log(`  Consumer OAuth detected: ${hasConsumer ? "yes (native agy recommended)" : "no"}`);
  } else if (cmd === "version") {
    console.log("claude-gemini-gateway v0.1.0");
  } else {
    console.log(`Usage: bun run src/index.ts [serve|doctor|version]`);
    process.exit(1);
  }
}
