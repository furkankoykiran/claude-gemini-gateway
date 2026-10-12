import { afterAll, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyInference, agyCatalog, resolveAgyModel } from "../src/agy.ts";
import { preflight, createGatewayServer } from "../src/server.ts";

const root = await mkdtemp(join(tmpdir(), "agy-fixture-"));
const binary = join(root, "agy");
// Native session files and credentials are deliberately absent. The fixture invokes the generated guard.
await writeFile(binary, `#!/usr/bin/env bun
import {readFile,appendFile} from 'node:fs/promises';
const mode=process.env.FIXTURE_MODE;
if(process.argv.includes('--help')) {console.error('--agent --input-format --output-format --json-schema --disable-slash-commands');process.exit(0)}
if(process.argv.includes('models')){console.log('fixture-model Fixture model');process.exit(0)}
if(mode==='unauthenticated')process.exit(1);
const conversation=crypto.randomUUID();
console.log(JSON.stringify({event:'init',conversation_id:conversation,init:{model:'fixture-model'}}));
for await (const line of console){
 const req=JSON.parse(line);const hooks=JSON.parse(await readFile('.agents/hooks.json','utf8'));
 const command=hooks['gateway-native-deny'].PreInvocation[0].command;
 const guard=Bun.spawn(['sh','-c',command],{cwd:'.agents',stdin:'pipe',stdout:'pipe'});
 guard.stdin.write(JSON.stringify({conversationId:conversation}));guard.stdin.end();await guard.exited;
 if(mode==='native'){console.log(JSON.stringify({event:'step_update',step_update:{conversation_id:conversation,step_type:'tool',tool_name:'any-native-tool'}}));continue}
 if(mode==='timeout'){await new Promise(()=>{});continue}
 if(mode==='malformed'){console.log('not-json');continue}
 const prompt=JSON.parse(req.message.content.split('REQUEST:\\n')[1]);
 let text=prompt.current_user_text||'RESULT_SEEN';
 const nonce=text.match(/exactly ([a-f0-9-]+) and/);if(nonce)text=nonce[1];
 const tool_calls=text==='REQUEST_TOOL'?[{name:'fixture_external',input:{value:'nested'}}]:[];
 console.log(JSON.stringify({event:'result',result:{conversation_id:mode==='stale'?'other':conversation,status:'SUCCESS',num_turns:1,structured_output:{text:tool_calls.length?'':text,tool_calls}}}));
 if(mode==='late'){await new Promise(r=>setTimeout(r,10));console.log(JSON.stringify({event:'result',result:{}}));}
 process.exit(0);
}
`, { mode: 0o700 });
const env = (mode = "valid") => ({ ...process.env, GEMINI_GATEWAY_ADAPTER: "agy-cli", AGY_GATEWAY_BIN: binary, AGY_GATEWAY_MODEL: "fixture-model", FIXTURE_MODE: mode });
afterAll(() => rm(root, { recursive: true, force: true }));

test("native CLI discovery and authenticated nonce preflight need no API key", async () => {
  expect(await agyCatalog(env(), AbortSignal.timeout(2000))).toEqual(["fixture-model"]);
  expect(await preflight(env(), AbortSignal.timeout(2000))).toEqual({ adapter: "agy-cli", model: "fixture-model", authenticated: true });
});
for (const mode of ["unauthenticated", "malformed", "stale", "native", "late", "timeout"]) test(`AGY ${mode} fails closed`, async () => {
  await expect(agyInference(env(mode), "fixture-model", { current_user_text: "nonce" }, AbortSignal.timeout(150))).rejects.toThrow();
});
test("missing native binary fails closed", async () => {
  await expect(preflight({ ...env(), AGY_GATEWAY_BIN: join(root, "missing") }, AbortSignal.timeout(200))).rejects.toThrow();
});
test("Gemini missing/invalid credentials cannot fall back to AGY", async () => {
  const api = { GEMINI_GATEWAY_ADAPTER: "gemini-api", GEMINI_GATEWAY_MODEL: "fixture-model", AGY_GATEWAY_BIN: binary };
  await expect(preflight(api, AbortSignal.timeout(200))).rejects.toThrow();
  await expect(preflight({ ...api, GEMINI_API_KEY: "fixture-key" }, AbortSignal.timeout(200), async () => new Response("denied", { status: 401 }))).rejects.toThrow();
  const result = await preflight({ ...api, GEMINI_API_KEY: "fixture-key" }, AbortSignal.timeout(200), async (_, init) => {
    const text = JSON.parse(init!.body as string).contents[0].parts[0].text.replace('Reply exactly ', '');
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] });
  });
  expect(result.adapter).toBe("gemini-api");
});
test("external tools, one result continuation, and fresh text have strict ownership", async () => {
  const server = createGatewayServer({ port: 0, env: env() });
  const post = (messages: any[]) => fetch(`${server.url}v1/messages`, { method: "POST", headers: { "Content-Type": "application/json", "x-claude-code-session-id": "fixture-session" }, body: JSON.stringify({ model: "claude-alias", messages, tools: [{ name: "fixture_external", input_schema: { type: "object", required: ["value"] } }] }) });
  try {
    const first: any = await (await post([{ role: "user", content: "REQUEST_TOOL" }])).json();
    expect(first.stop_reason).toBe("tool_use");
    const messages = [{ role: "user", content: "REQUEST_TOOL" }, { role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: first.content[0].id, content: "actual result" }] }];
    expect((await (await post(messages)).json()).content[0].text).toBe("RESULT_SEEN");
    expect((await post(messages)).status).toBe(400);
    messages.push({ role: "user", content: "FRESH_TURN" });
    expect((await (await post(messages)).json()).content[0].text).toBe("FRESH_TURN");
  } finally { server.stop(true); }
});

test("explicit native request models are honored; only frontend aliases delegate to native defaults", () => {
  expect(resolveAgyModel("catalog-selected-model", {})).toBe("catalog-selected-model");
  expect(resolveAgyModel("agy", {})).toBeUndefined();
  expect(resolveAgyModel("claude-frontend-alias", {})).toBeUndefined();
  expect(resolveAgyModel("catalog-selected-model", { AGY_GATEWAY_MODEL: "configured-model" })).toBe("configured-model");
  expect(() => resolveAgyModel("<placeholder>", {})).toThrow();
});
