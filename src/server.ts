import { agyCatalog, agyInference, agyPrompt } from "./agy.ts";
import { version } from "../package.json";
import { resolveGoogleCredentials } from "./auth.ts";
import { resolveGeminiModel, translateAnthropicToGemini, translateGeminiToAnthropic } from "./translate.ts";
import { actionableText, currentTurn, ToolCycles } from "./contract.ts";
import type { AnthropicMessagesRequest, AnthropicContentBlockToolUse } from "./types.ts";

export interface ServerOptions {
  port?: number;
  host?: string;
  env?: Record<string, string | undefined>;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

function failure(message: string, status = 502) {
  return Response.json({ type: "error", error: { type: status === 400 ? "invalid_request_error" : status === 401 ? "authentication_error" : "api_error", message } }, { status });
}

/** Buffer a complete provider response before publishing tool IDs or a successful terminal event. */
async function readGoogleStream(response: Response): Promise<any> {
  if (!response.body) throw new Error("Google stream has no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parts: any[] = [];
  let candidate: any;
  let usageMetadata: any;
  const consume = (frame: string) => {
    const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    const row = JSON.parse(data);
    if (row.error) throw new Error("Google stream reported an error.");
    if (row.promptFeedback?.blockReason) throw new Error("Google blocked the request.");
    const next = row.candidates?.[0];
    if (next) {
      if (candidate?.finishReason && next.content?.parts?.length) throw new Error("Google emitted content after a terminal candidate.");
      candidate = { ...candidate, ...next };
      parts.push(...(next.content?.parts ?? []));
    }
    usageMetadata = row.usageMetadata ?? usageMetadata;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replaceAll("\r\n", "\n");
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
    return { candidates: candidate ? [{ ...candidate, content: { ...candidate.content, parts } }] : [], usageMetadata };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function anthropicSse(message: any): string {
  const events: string[] = [];
  const send = (type: string, data: object) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", { message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } });
  for (const [index, block] of message.content.entries()) {
    send("content_block_start", { index, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } });
    send("content_block_delta", { index, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } });
    send("content_block_stop", { index });
  }
  send("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } });
  send("message_stop", {});
  return events.join("");
}

export function createGatewayServer(options: ServerOptions = {}) {
  const env = options.env ?? process.env;
  const adapter = resolveAdapter(env);
  const port = options.port ?? Number(env.GEMINI_GATEWAY_PORT ?? 4141);
  const host = options.host ?? env.GEMINI_GATEWAY_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("Gateway must bind to loopback.");
  const timeoutMs = options.timeoutMs ?? Number(env.GEMINI_GATEWAY_TIMEOUT_MS ?? 300_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Gateway timeout must be a positive integer in milliseconds.");
  const upstream = options.fetch ?? fetch;
  const cycles = new ToolCycles(timeoutMs);
  const active = new Set<AbortController>();
  const server = Bun.serve({
    port, hostname: host,
    async fetch(req) {
      const url = new URL(req.url);
      if (["/health", "/healthz"].includes(url.pathname)) {
        let auth = "unavailable";
        try { auth = adapter === "agy-cli" ? "native-cli-not-preflighted" : resolveGoogleCredentials(env).kind; } catch {}
        return Response.json({ ok: true, status: "ok", provider: "gemini", adapter, version, model: env.GEMINI_GATEWAY_MODEL || env.GEMINI_MODEL || null, execution_owner: "claude-code", timeout_ms: timeoutMs, auth });
      }
      if (url.pathname !== "/v1/models" && (url.pathname !== "/v1/messages" || req.method !== "POST")) return new Response("Not Found", { status: 404 });
      let creds;
      try { creds = adapter === "agy-cli" ? undefined : resolveGoogleCredentials(env); } catch (error) { return failure((error as Error).message, 401); }
      const controller = new AbortController();
      const cancel = () => controller.abort();
      req.signal.addEventListener("abort", cancel, { once: true });
      if (req.signal.aborted) cancel();
      active.add(controller);
      const deadline = setTimeout(cancel, timeoutMs);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (creds?.kind === "api-key") headers["x-goog-api-key"] = creds.apiKey!;
      else if (creds) headers.Authorization = `Bearer ${env.GOOGLE_OAUTH_TOKEN}`;
      const base = googleBase(env, creds);
      try {
        if (adapter === "agy-cli") {
          if (url.pathname === "/v1/models") return Response.json({ data: (await agyCatalog(env, controller.signal)).map((id) => ({ id, object: "model", owned_by: "antigravity" })) });
          const body: AnthropicMessagesRequest = await req.json();
          let current;
          const selected = env.AGY_GATEWAY_MODEL || undefined;
          try { current = currentTurn(body); cycles.claim(body, req.headers.get("x-claude-code-session-id"), selected || "native-default"); }
          catch (error) { return failure((error as Error).message, 400); }
          const result = await agyInference(env, selected, agyPrompt(body, current), controller.signal);
          if (controller.signal.aborted) throw new Error("cancelled");
          const calls = result.output.tool_calls.map((call: any) => {
            const tool = body.tools?.find((tool) => tool.name === call.name);
            if (!tool || !call.input || typeof call.input !== "object" || Array.isArray(call.input) || tool.input_schema.required?.some((key) => !(key in call.input))) throw new Error("Invalid external tool proposal.");
            return { type: "tool_use", id: `call_${crypto.randomUUID()}`, name: call.name, input: call.input };
          });
          cycles.issue(calls, calls, req.headers.get("x-claude-code-session-id"), selected || "native-default");
          const message = { id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model: result.model, content: [...(result.output.text ? [{ type: "text", text: result.output.text }] : []), ...calls], stop_reason: calls.length ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
          return body.stream ? new Response(anthropicSse(message), { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" } }) : Response.json(message);
        }
        if (url.pathname === "/v1/models") {
          if (req.method !== "GET") return new Response("Not Found", { status: 404 });
          if (creds!.kind === "vertex") {
            const model = env.GEMINI_GATEWAY_MODEL || env.GEMINI_MODEL;
            if (!model) return failure("Configure a Vertex model; model discovery is unavailable for this transport.", 400);
            return Response.json({ data: [{ id: resolveGeminiModel(model, env), object: "model", owned_by: "google", configured: true }], discovery: "configured-only" });
          }
          const data: any[] = [];
          let page = "";
          do {
            const response = await upstream(`${base}/models${page ? `?pageToken=${encodeURIComponent(page)}` : ""}`, { headers, signal: controller.signal });
            if (!response.ok) return failure(`Google model discovery failed (${response.status}).`, response.status);
            const body: any = await response.json();
            for (const model of body.models ?? []) if (model.supportedGenerationMethods?.includes("generateContent")) data.push({ id: model.name.replace(/^models\//, ""), object: "model", owned_by: "google" });
            page = body.nextPageToken ?? "";
          } while (page && !controller.signal.aborted);
          if (controller.signal.aborted) throw new Error("cancelled");
          return Response.json({ data });
        }
        let body: AnthropicMessagesRequest;
        let model: string;
        let geminiReq;
        try {
          body = await req.json();
          currentTurn(body);
          model = resolveGeminiModel(body.model, env);
          const issuedParts = cycles.claim(body, req.headers.get("x-claude-code-session-id"), model);
          const clean = structuredClone(body);
          for (const message of clean.messages) {
            if (message.role === "user") {
              if (typeof message.content === "string") message.content = actionableText(message.content);
              else message.content = message.content.filter((block) => block.type !== "text" || actionableText(block.text)).map((block) => block.type === "text" ? { ...block, text: actionableText(block.text) } : block);
            }
          }
          geminiReq = translateAnthropicToGemini(clean, issuedParts);

        } catch (error) { return failure((error as Error).message, 400); }
        const action = body.stream ? "streamGenerateContent?alt=sse" : "generateContent";
        const response = await upstream(`${base}/models/${encodeURIComponent(model)}:${action}`, { method: "POST", headers, body: JSON.stringify(geminiReq), signal: controller.signal });
        if (!response.ok) { await response.body?.cancel(); return failure(`Google inference failed (${response.status}).`, response.status); }
        const google = body.stream ? await readGoogleStream(response) : await response.json();
        if (controller.signal.aborted) throw new Error("cancelled");
        const message: any = translateGeminiToAnthropic(google, model);
        const calls = message.content.filter((block: any): block is AnthropicContentBlockToolUse => block.type === "tool_use");
        for (const call of calls) {
          const tool = body.tools?.find((tool) => tool.name === call.name);
          if (!tool || !call.input || typeof call.input !== "object" || Array.isArray(call.input) || tool.input_schema.required?.some((key) => !(key in call.input))) throw new Error("Google returned an undeclared tool or invalid required arguments.");
        }
        cycles.issue(calls, google.candidates[0].content.parts.filter((part: any) => part.functionCall), req.headers.get("x-claude-code-session-id"), model);
        return body.stream ? new Response(anthropicSse(message), { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" } }) : Response.json(message);
      } catch {
        return failure(controller.signal.aborted ? "Google request cancelled or timed out." : "Google transport or response validation failed.");
      } finally {
        clearTimeout(deadline);
        req.signal.removeEventListener("abort", cancel);
        active.delete(controller);
      }
    },
  });
  const originalStop = server.stop.bind(server);
  server.stop = ((closeActive?: boolean) => { for (const controller of active) controller.abort(); cycles.clear(); return originalStop(closeActive); }) as typeof server.stop;
  return server;
}

/** Explicit adapter selection prevents consumer auth from becoming API auth. */
export function resolveAdapter(env: Record<string, string | undefined>): "agy-cli" | "gemini-api" | "vertex" {
  const adapter = env.GEMINI_GATEWAY_ADAPTER || (env.GOOGLE_OAUTH_TOKEN ? "vertex" : "gemini-api");
  if (!["agy-cli", "gemini-api", "vertex"].includes(adapter)) throw new Error("Unknown Google gateway adapter.");
  if (adapter !== "agy-cli") {
    let credentials;
    try { credentials = resolveGoogleCredentials(env); } catch { return adapter as "gemini-api" | "vertex"; }
    if ((adapter === "vertex") !== (credentials.kind === "vertex")) throw new Error("Credentials do not match the selected Google adapter.");
  }
  return adapter as "agy-cli" | "gemini-api" | "vertex";
}

function googleBase(env: Record<string, string | undefined>, creds: ReturnType<typeof resolveGoogleCredentials> | undefined) {
  if (!creds) return "";
  return (env.GEMINI_GATEWAY_API_BASE_URL || (creds.kind === "api-key" ? "https://generativelanguage.googleapis.com/v1beta" : `https://${creds.location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(creds.project!)}/locations/${encodeURIComponent(creds.location!)}/publishers/google`)).replace(/\/$/, "");
}

export async function preflight(env: Record<string, string | undefined>, signal: AbortSignal, upstream: NonNullable<ServerOptions["fetch"]> = fetch) {
  const adapter = resolveAdapter(env);
  const nonce = crypto.randomUUID();
  if (adapter === "agy-cli") {
    const models = await agyCatalog(env, signal);
    if (env.AGY_GATEWAY_MODEL && !models.includes(env.AGY_GATEWAY_MODEL)) throw new Error("Configured AGY model is absent from the native catalog.");
    const result = await agyInference(env, env.AGY_GATEWAY_MODEL, { current_user_text: `Reply with text exactly ${nonce} and no tool_calls.` }, signal);
    if (result.output.text !== nonce || result.output.tool_calls.length) throw new Error("AGY preflight did not return the current nonce.");
    return { adapter, model: result.model, authenticated: true };
  }
  const creds = resolveGoogleCredentials(env);
  const model = resolveGeminiModel(env.GEMINI_GATEWAY_MODEL || env.GEMINI_MODEL || "", env);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (creds.kind === "api-key") headers["x-goog-api-key"] = creds.apiKey!;
  else headers.Authorization = `Bearer ${env.GOOGLE_OAUTH_TOKEN}`;
  const response = await upstream(`${googleBase(env, creds)}/models/${encodeURIComponent(model)}:generateContent`, { method: "POST", headers, signal, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: `Reply exactly ${nonce}` }] }], generationConfig: { maxOutputTokens: 128 } }) });
  if (!response.ok) throw new Error(`Google credential/inference preflight failed (${response.status}).`);
  const message: any = translateGeminiToAnthropic(await response.json(), model);
  if (message.content.some((block: any) => block.type !== "text") || !message.content.map((block: any) => block.text).join("").includes(nonce)) throw new Error("Google preflight did not return the current nonce.");
  return { adapter, model, authenticated: true };
}
