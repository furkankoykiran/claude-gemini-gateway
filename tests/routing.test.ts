import { test, expect } from "bun:test";
import { createGatewayServer } from "../src/server.ts";
import { currentTurn, ToolCycles } from "../src/contract.ts";
import { resolveGoogleCredentials } from "../src/auth.ts";
import { translateAnthropicToGemini } from "../src/translate.ts";
import type { AnthropicMessagesRequest } from "../src/types.ts";

const tool = { name: "runtime_tool", input_schema: { type: "object" as const, properties: { nested: { type: "array", items: { type: "boolean" } } }, required: ["nested"] } };
const initial: AnthropicMessagesRequest = { model: "runtime-model", messages: [{ role: "user", content: "Use the offered tool." }], tools: [tool] };
const google = (parts: any[], finishReason = "STOP") => ({ candidates: [{ content: { role: "model", parts }, finishReason }] });
const signature = "opaque-fixture-signature";
const callPart = { functionCall: { name: tool.name, args: { nested: [true, false] } }, thoughtSignature: signature };
const request = (body: AnthropicMessagesRequest, session = "session-a", signal?: AbortSignal) => new Request("http://localhost/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-claude-code-session-id": session }, body: JSON.stringify(body), signal });
function continuation(call: any, is_error = false): AnthropicMessagesRequest {
  return { ...initial, messages: [...initial.messages, { role: "assistant", content: [call] }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: is_error ? "actual timeout" : "actual result", is_error }] }] };
}
function fixture(respond: (init: RequestInit | undefined, index: number) => Promise<Response> | Response, timeoutMs = 1000) {
  const writes: RequestInit[] = [];
  const server = createGatewayServer({ port: 0, env: { GEMINI_API_KEY: "fixture-key" }, timeoutMs, fetch: (async (_url, init) => { writes.push(init!); return respond(init, writes.length); }) as typeof fetch });
  return { server, writes, post: (body: AnthropicMessagesRequest, session?: string, signal?: AbortSignal) => server.fetch(request(body, session, signal)) };
}

test("current user text wins over merged historical tool results; reminder-only and completed turns cannot infer", () => {
  const merged = continuation({ type: "tool_use", id: "historical", name: tool.name, input: {} });
  (merged.messages.at(-1)!.content as any[]).push({ type: "text", text: "NEW_CURRENT_TURN" });
  expect(currentTurn(merged)).toEqual({ text: "NEW_CURRENT_TURN", results: [] });
  for (const content of ["<system-reminder>old text</system-reminder>", ""]) expect(() => currentTurn({ ...initial, messages: [{ role: "user", content }] })).toThrow();
  expect(() => currentTurn({ ...initial, messages: [...initial.messages, { role: "assistant", content: "done" }] })).toThrow("No current user turn");
  expect(currentTurn({ ...initial, messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>metadata</system-reminder>" }, { type: "text", text: "CURRENT" }] }] }).text).toBe("CURRENT");
});

for (const failed of [false, true]) test(`real ${failed ? "failed" : "successful"} Claude result resumes once with opaque provider signature`, async () => {
  const f = fixture((_init, index) => Response.json(google(index === 1 ? [callPart] : [{ text: "DONE" }])));
  try {
    const first: any = await (await f.post(initial)).json();
    const call = first.content[0];
    expect(call.input).toEqual({ nested: [true, false] });
    const body = continuation(call, failed);
    const wrong = await f.post(body, "other-session");
    expect(wrong.status).toBe(400);
    expect(f.writes).toHaveLength(1);
    const result: any = await (await f.post(body)).json();
    expect(result.content[0].text).toBe("DONE");
    const sent = JSON.parse(f.writes[1]!.body as string);
    expect(sent.contents[1].parts[0].thoughtSignature).toBe(signature);
    expect(sent.contents[2].parts[0].functionResponse.response).toEqual({ content: failed ? "actual timeout" : "actual result", ...(failed ? { is_error: true } : {}) });
    expect((await f.post(body)).status).toBe(400);
    expect(f.writes).toHaveLength(2);
    expect((await f.post({ ...initial, messages: [...body.messages, { role: "assistant", content: "DONE" }, { role: "user", content: "NEW" }] })).status).toBe(200);
  } finally { f.server.stop(true); }
});

test("incomplete or duplicate multi-tool results cannot consume a cycle", () => {
  const cycles = new ToolCycles(1000);
  const calls = ["one", "two"].map((id) => ({ type: "tool_use" as const, id, name: tool.name, input: {} }));
  cycles.issue(calls, [callPart, callPart], "s", initial.model);
  const body: AnthropicMessagesRequest = { ...initial, messages: [...initial.messages, { role: "assistant", content: calls }, { role: "user", content: calls.map((call) => ({ type: "tool_result", tool_use_id: call.id, content: call.id })) }] };
  const partial = structuredClone(body); (partial.messages.at(-1)!.content as any[]).pop();
  expect(() => cycles.claim(partial, "s", initial.model)).toThrow();
  const duplicate = structuredClone(body); (duplicate.messages.at(-1)!.content as any[])[1] = (duplicate.messages.at(-1)!.content as any[])[0];
  expect(() => cycles.claim(duplicate, "s", initial.model)).toThrow();
  expect(cycles.claim(body, "s", initial.model).size).toBe(2);
  expect(() => cycles.claim(body, "s", initial.model)).toThrow();
  cycles.clear();
});

test("tool cycle expires while Claude executes; late results fail closed", async () => {
  const cycles = new ToolCycles(10);
  const call = { type: "tool_use" as const, id: crypto.randomUUID(), name: tool.name, input: {} };
  cycles.issue([call], [callPart], "s", initial.model);
  await Bun.sleep(25);
  expect(() => cycles.claim(continuation(call), "s", initial.model)).toThrow();
  cycles.clear();
});

for (const bad of ["malformed", "truncated", "SAFETY", "undeclared"]) test(`provider ${bad} cannot produce a successful SSE terminal`, async () => {
  const f = fixture(() => bad === "malformed" ? new Response("data: {invalid}\n\n") : new Response(`data: ${JSON.stringify(google(bad === "undeclared" ? [{ functionCall: { name: "unoffered", args: {} } }] : [{ text: "text" }], bad === "truncated" ? undefined as any : bad === "SAFETY" ? "SAFETY" : "STOP")).replace(bad === "truncated" ? ',"finishReason":"STOP"' : "unused", "")}\n\n`));
  try {
    const response = await f.post({ ...initial, stream: true });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("message_stop");
  } finally { f.server.stop(true); }
});

test("fragmented SSE preserves generic nested arguments and emits one terminal", async () => {
  const frames = `data: ${JSON.stringify(google([callPart]))}\r\n\r\n`;
  const f = fixture(() => new Response(new ReadableStream({ start(controller) { const bytes = new TextEncoder().encode(frames); for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close(); } })));
  try {
    const response = await f.post({ ...initial, stream: true });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('"input":{}');
    expect(text).toContain('"type":"input_json_delta"');
    expect(text).toContain('nested');
    expect(text.match(/event: message_stop/g)).toHaveLength(1);
  } finally { f.server.stop(true); }
});

for (const abort of [false, true]) test(`${abort ? "client cancellation" : "timeout"} aborts transport and prevents late success`, async () => {
  let aborted = false;
  const f = fixture((init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }); }), 20);
  try {
    const controller = new AbortController();
    const result = f.post(initial, "s", controller.signal);
    if (abort) setTimeout(() => controller.abort(), 5);
    const response = await result;
    expect(response.status).toBe(502);
    expect(aborted).toBe(true);
  } finally { f.server.stop(true); }
});

test("rejects promptless requests before provider traffic and never invents a user greeting", async () => {
  const f = fixture(() => Response.json(google([{ text: "OK" }])));
  try {
    expect((await f.post({ ...initial, messages: [{ role: "user", content: "<system-reminder>old</system-reminder>" }] })).status).toBe(400);
    expect(f.writes).toHaveLength(0);
    const translated = translateAnthropicToGemini({ ...initial, messages: [{ role: "assistant", content: "history" }, { role: "user", content: "current" }] });
    expect(translated.contents[0]!.role).toBe("model");
    expect(JSON.stringify(translated)).not.toContain("Hello");
    expect(() => translateAnthropicToGemini({ ...initial, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "unknown", content: "x" }] }] })).toThrow("matching assistant");
    expect(() => resolveGoogleCredentials({ GOOGLE_APPLICATION_CREDENTIALS: "/fixture/path" })).toThrow("ADC file path");
    expect(() => createGatewayServer({ host: "0.0.0.0" })).toThrow("loopback");
  } finally { f.server.stop(true); }
});

test("configured model and port derive from the supplied environment, and health is not entitlement", async () => {
  const server = createGatewayServer({ env: { GEMINI_GATEWAY_PORT: "0", GEMINI_GATEWAY_MODEL: "configured-model" } });
  try {
    const health: any = await (await server.fetch(new Request("http://localhost/healthz"))).json();
    expect(health.model).toBe("configured-model");
    expect(health.auth).toBe("unavailable");
    expect(health.execution_owner).toBe("claude-code");
    expect((await server.fetch(request(initial))).status).toBe(401);
  } finally { server.stop(true); }
});


test("late stream content after terminal completion fails closed", async () => {
  const f = fixture(() => new Response(`data: ${JSON.stringify(google([{ text: "DONE" }]))}\n\ndata: ${JSON.stringify(google([callPart]))}\n\n`));
  try {
    const response = await f.post({ ...initial, stream: true });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("message_stop");
  } finally { f.server.stop(true); }
});

test("a transport that resolves after cancellation cannot publish tool IDs", async () => {
  const f = fixture(async () => { await Bun.sleep(25); return Response.json(google([callPart])); }, 10);
  try {
    const response = await f.post(initial);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("tool_use");
  } finally { f.server.stop(true); }
});
