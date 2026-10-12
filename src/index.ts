import { version } from "../package.json";
import { createGatewayServer } from "./server.ts";
import { resolveGoogleCredentials, detectConsumerOAuth } from "./auth.ts";

export * from "./types.ts";
export * from "./auth.ts";
export * from "./translate.ts";
export * from "./server.ts";

const cmd = process.argv[2] ?? "serve";

if (import.meta.main) {
  if (cmd === "serve" || cmd === "start") {
    let env = process.env;
    if (process.env.GEMINI_GATEWAY_CONFIG) {
      try {
        const config = await Bun.file(process.env.GEMINI_GATEWAY_CONFIG).json();
        if (!config.env || typeof config.env !== "object" || Array.isArray(config.env) || Object.values(config.env).some((value) => typeof value !== "string")) throw new Error("invalid env");
        env = { ...config.env, ...process.env };
      } catch {
        console.error("Invalid Gemini gateway environment configuration.");
        process.exit(1);
      }
    }
    const server = createGatewayServer({ env });
    const host = env.GEMINI_GATEWAY_HOST || "127.0.0.1";
    console.log(`[claude-gemini-gateway] listening on http://${host}:${server.port}`);
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { server.stop(true); process.exit(0); });
  } else if (cmd === "doctor") {
    console.log("[claude-gemini-gateway] environment doctor:");
    try {
      const creds = resolveGoogleCredentials();
      console.log(`  Auth configured: ${creds.kind} (not an entitlement check)`);
    } catch (e: any) {
      console.log(`  Auth unavailable: ${e.message}`);
      process.exitCode = 1;
    }
    const hasConsumer = detectConsumerOAuth();
    console.log(`  Consumer OAuth detected: ${hasConsumer ? "yes (native agy recommended)" : "no"}`);
  } else if (cmd === "version") {
    console.log(`claude-gemini-gateway v${version}`);
  } else {
    console.log(`Usage: bun run src/index.ts [serve|doctor|version]`);
    process.exit(1);
  }
}
