import { resolveGoogleCredentials, detectConsumerOAuth } from "./auth.ts";
import {
  resolveGeminiModel,
  translateAnthropicToGemini,
  translateGeminiToAnthropic,
} from "./translate.ts";
import type { AnthropicMessagesRequest } from "./types.ts";

export interface ServerOptions {
  port?: number;
  host?: string;
  env?: Record<string, string | undefined>;
}

export function createGatewayServer(options: ServerOptions = {}) {
  const port = options.port ?? Number(process.env["GEMINI_GATEWAY_PORT"] || 4141);
  const host = options.host ?? process.env["GEMINI_GATEWAY_HOST"] ?? "127.0.0.1";
  const env = options.env ?? process.env;

  const server = Bun.serve({
    port,
    hostname: host,
    async fetch(req) {
      const url = new URL(req.url);

      // CORS Preflight
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*",
          },
        });
      }

      // Health check endpoint
      if (url.pathname === "/health" || url.pathname === "/healthz") {
        return Response.json(
          {
            status: "ok",
            provider: "gemini",
            version: "0.1.0",
            uptime: process.uptime(),
          },
          {
            headers: { "Access-Control-Allow-Origin": "*" },
          }
        );
      }

      // Models endpoint
      if (url.pathname === "/v1/models" && req.method === "GET") {
        return Response.json(
          {
            data: [
              { id: "gemini-3.8-flash", object: "model", created: Date.now(), owned_by: "google" },
              { id: "gemini-2.5-pro", object: "model", created: Date.now(), owned_by: "google" },
              { id: "gemini-2.5-flash", object: "model", created: Date.now(), owned_by: "google" },
              { id: "gemini-2.0-flash", object: "model", created: Date.now(), owned_by: "google" },
            ],
          },
          {
            headers: { "Access-Control-Allow-Origin": "*" },
          }
        );
      }

      // Messages endpoint
      if (url.pathname === "/v1/messages" && req.method === "POST") {
        // Authenticate credentials
        let creds;
        try {
          creds = resolveGoogleCredentials(env);
        } catch (err: any) {
          return Response.json(
            {
              type: "error",
              error: {
                type: "authentication_error",
                message: err.message,
              },
            },
            {
              status: 401,
              headers: { "Access-Control-Allow-Origin": "*" },
            }
          );
        }

        let body: AnthropicMessagesRequest;
        try {
          body = await req.json();
        } catch {
          return Response.json(
            {
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "Malformed JSON body",
              },
            },
            {
              status: 400,
              headers: { "Access-Control-Allow-Origin": "*" },
            }
          );
        }

        const model = resolveGeminiModel(body.model, env);
        const geminiReq = translateAnthropicToGemini(body);

        let endpointUrl: string;
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };

        if (creds.kind === "api-key") {
          const action = body.stream ? "streamGenerateContent?alt=sse" : "generateContent";
          endpointUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${action}&key=${creds.apiKey}`;
        } else {
          // Vertex AI path
          const action = body.stream ? "streamGenerateContent?alt=sse" : "generateContent";
          endpointUrl = `https://${creds.location}-aiplatform.googleapis.com/v1/projects/${creds.project}/locations/${creds.location}/publishers/google/models/${model}:${action}`;
          if (env["GOOGLE_OAUTH_TOKEN"]) {
            headers["Authorization"] = `Bearer ${env["GOOGLE_OAUTH_TOKEN"]}`;
          }
        }

        try {
          const geminiRes = await fetch(endpointUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(geminiReq),
          });

          if (!geminiRes.ok) {
            const errText = await geminiRes.text();
            return Response.json(
              {
                type: "error",
                error: {
                  type: "api_error",
                  message: `Google Gemini API error (${geminiRes.status}): ${errText}`,
                },
              },
              {
                status: geminiRes.status,
                headers: { "Access-Control-Allow-Origin": "*" },
              }
            );
          }

          if (body.stream) {
            // Streaming SSE response
            const stream = new ReadableStream({
              async start(controller) {
                const encoder = new TextEncoder();
                const sendEvent = (event: string, data: unknown) => {
                  controller.enqueue(
                    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
                  );
                };

                const msgId = `msg_${Math.random().toString(36).slice(2, 14)}`;
                sendEvent("message_start", {
                  type: "message_start",
                  message: {
                    id: msgId,
                    type: "message",
                    role: "assistant",
                    model,
                    content: [],
                    stop_reason: null,
                    usage: { input_tokens: 0, output_tokens: 0 },
                  },
                });

                let blockIndex = 0;
                let stopReason = "end_turn";
                let outputTokens = 0;

                const reader = geminiRes.body?.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                if (reader) {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() ?? "";

                    for (const line of lines) {
                      if (!line.startsWith("data: ")) continue;
                      const jsonStr = line.slice(6).trim();
                      if (!jsonStr) continue;

                      try {
                        const parsed = JSON.parse(jsonStr);
                        const candidate = parsed?.candidates?.[0];
                        const parts = candidate?.content?.parts ?? [];

                        for (const part of parts) {
                          if (part.text) {
                            sendEvent("content_block_start", {
                              type: "content_block_start",
                              index: blockIndex,
                              content_block: { type: "text", text: "" },
                            });
                            sendEvent("content_block_delta", {
                              type: "content_block_delta",
                              index: blockIndex,
                              delta: { type: "text_delta", text: part.text },
                            });
                            sendEvent("content_block_stop", {
                              type: "content_block_stop",
                              index: blockIndex,
                            });
                            blockIndex++;
                          } else if (part.functionCall) {
                            stopReason = "tool_use";
                            const callId = `call_${Math.random().toString(36).slice(2, 10)}`;
                            sendEvent("content_block_start", {
                              type: "content_block_start",
                              index: blockIndex,
                              content_block: {
                                type: "tool_use",
                                id: callId,
                                name: part.functionCall.name,
                                input: {},
                              },
                            });
                            sendEvent("content_block_delta", {
                              type: "content_block_delta",
                              index: blockIndex,
                              delta: {
                                type: "input_json_delta",
                                partial_json: JSON.stringify(part.functionCall.args ?? {}),
                              },
                            });
                            sendEvent("content_block_stop", {
                              type: "content_block_stop",
                              index: blockIndex,
                            });
                            blockIndex++;
                          }
                        }

                        if (parsed?.usageMetadata?.candidatesTokenCount) {
                          outputTokens = parsed.usageMetadata.candidatesTokenCount;
                        }
                      } catch {
                        // ignore malformed chunks
                      }
                    }
                  }
                }

                sendEvent("message_delta", {
                  type: "message_delta",
                  delta: { stop_reason: stopReason, stop_sequence: null },
                  usage: { output_tokens: outputTokens },
                });
                sendEvent("message_stop", { type: "message_stop" });
                controller.close();
              },
            });

            return new Response(stream, {
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": "*",
              },
            });
          } else {
            // Non-streaming response
            const geminiJson = await geminiRes.json();
            const anthropicJson = translateGeminiToAnthropic(geminiJson, model);
            return Response.json(anthropicJson, {
              headers: { "Access-Control-Allow-Origin": "*" },
            });
          }
        } catch (err: any) {
          return Response.json(
            {
              type: "error",
              error: {
                type: "api_error",
                message: `Failed to connect to Google Gemini: ${err.message}`,
              },
            },
            {
              status: 502,
              headers: { "Access-Control-Allow-Origin": "*" },
            }
          );
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  return server;
}
