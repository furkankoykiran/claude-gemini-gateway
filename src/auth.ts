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
    env["ANTHROPIC_VERTEX_PROJECT_ID"] ||
    env["VERTEX_PROJECT_ID"] ||
    env["GOOGLE_CLOUD_PROJECT"];

  if (vertexProject && !vertexProject.startsWith("<") && vertexProject.trim().length > 0 && env["GOOGLE_OAUTH_TOKEN"]?.trim()) {
    return {
      kind: "vertex",
      project: env["ANTHROPIC_VERTEX_PROJECT_ID"] || env["VERTEX_PROJECT_ID"] || env["GOOGLE_CLOUD_PROJECT"],
      location: env["CLOUD_ML_REGION"] || env["VERTEX_LOCATION"] || "us-central1",
    };
  }

  if (detectConsumerOAuth(env)) {
    throw new Error(
      "Claude Code inference requires officially supported Gemini API or Vertex credentials. Personal Antigravity consumer OAuth cannot be reused, copied, or proxied into Claude Code. Use native 'agy' CLI instead with your configured model"
    );
  }

  throw new Error(
    "No supported Google credentials found. Please set GEMINI_API_KEY in your environment or configure a Vertex project and GOOGLE_OAUTH_TOKEN (an official Google Cloud access token). An ADC file path alone is not an access token. Personal Antigravity consumer OAuth is rejected in favor of native agy."
  );
}
