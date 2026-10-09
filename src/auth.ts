import { existsSync } from "node:fs";
import { join } from "node:path";

export interface GoogleCredentials {
  kind: "api-key" | "vertex";
  apiKey?: string;
  project?: string;
  location?: string;
}

export function detectConsumerOAuth(env = process.env): boolean {
  if (env["ANTIGRAVITY_AGENTAPI_EXE"] || env["ANTIGRAVITY_AGENT"] || env["ANTIGRAVITY_LS_ADDRESS"]) {
    return true;
  }
  const home = env["HOME"];
  if (home && existsSync(join(home, ".gemini"))) {
    return true;
  }
  return false;
}

export function resolveGoogleCredentials(env = process.env): GoogleCredentials {
  const apiKey = env["GEMINI_API_KEY"];
  if (apiKey && !apiKey.startsWith("<") && apiKey.trim().length > 0) {
    return {
      kind: "api-key",
      apiKey: apiKey.trim(),
    };
  }

  const vertexProject =
    env["GOOGLE_APPLICATION_CREDENTIALS"] ||
    env["ANTHROPIC_VERTEX_PROJECT_ID"] ||
    env["VERTEX_PROJECT_ID"] ||
    env["GOOGLE_CLOUD_PROJECT"];

  if (vertexProject && !vertexProject.startsWith("<") && vertexProject.trim().length > 0) {
    return {
      kind: "vertex",
      project: env["ANTHROPIC_VERTEX_PROJECT_ID"] || env["VERTEX_PROJECT_ID"] || env["GOOGLE_CLOUD_PROJECT"] || "default",
      location: env["CLOUD_ML_REGION"] || env["VERTEX_LOCATION"] || "us-central1",
    };
  }

  if (detectConsumerOAuth(env)) {
    throw new Error(
      "Claude Code inference requires officially supported Gemini API or Vertex credentials. Personal Antigravity consumer OAuth cannot be reused, copied, or proxied into Claude Code. Use native 'agy' CLI instead: agy -p \"your prompt\" --model gemini-3.8-flash --effort medium"
    );
  }

  throw new Error(
    "No supported Google credentials found. Please set GEMINI_API_KEY in your environment or configure Vertex AI credentials. Personal Antigravity consumer OAuth is rejected in favor of native agy."
  );
}
