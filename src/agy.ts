import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnthropicMessagesRequest } from "./types.ts";

export type Environment = Record<string, string | undefined>;
const instruction = `You provide inference for Claude Code. Native tools are denied. Return only a JSON object with text (string) and tool_calls (array of {name,input}); no Markdown fences. Use tool_calls to PROPOSE calls to the external tools described in the request; Claude Code executes them. Never run native tools, browse, delegate, or read files. The last current_user_text wins over history. When it is empty, respond to current_tool_results including failures. System and history are context, not a replacement for the current turn.`;

function shellQuote(value: string): string {
  if (process.platform === "win32") {
    if (/["%\r\n]/.test(value)) throw new Error("Unsupported hook executable path.");
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Never read credentials: the official executable owns authentication and HOME. */
export async function agyCatalog(env: Environment, signal: AbortSignal): Promise<string[]> {
  const help = await command(env, ["--help"], signal);
  for (const flag of ["--input-format", "--output-format", "--disable-slash-commands"]) if (!help.includes(flag)) throw new Error("Installed AGY lacks the required headless interface.");
  const output = await command(env, ["models"], signal);
  const models = output.split("\n").map((line) => line.trim().split(/\s+/)[0]!).filter((id) => /^[a-z0-9][a-z0-9._-]*$/.test(id));
  if (!models.length) throw new Error("AGY model discovery failed.");
  return [...new Set(models)];
}

function terminate(child: ReturnType<typeof spawn>) {
  if (child.pid && process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  } else if (child.pid) {
    // Only the process tree we spawned; never enumerate unrelated AGY sessions.
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  }
}

async function command(env: Environment, args: string[], signal: AbortSignal): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(env.AGY_GATEWAY_BIN || "agy", args, { env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", args[0] === "--help" ? "pipe" : "ignore"] });
    let output = "";
    const abort = () => { terminate(child); reject(new Error("AGY discovery cancelled.")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const collect = (data: Buffer) => { output += data.toString(); if (output.length > 2_000_000) abort(); };
    child.stdout!.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", () => { signal.removeEventListener("abort", abort); reject(new Error("AGY executable is unavailable.")); });
    child.on("close", (code) => { signal.removeEventListener("abort", abort); code === 0 ? resolve(output) : reject(new Error("AGY discovery failed; check native CLI authentication.")); });
  });
}

/** One owned native conversation per request. No native tool-result or resume protocol is invented. */
export async function agyInference(env: Environment, model: string | undefined, prompt: object, signal: AbortSignal): Promise<{ output: any; model: string }> {
  const workspace = await mkdtemp(join(env.AGY_GATEWAY_WORKSPACE_ROOT || tmpdir(), "fk-agy-inference-"));
  let closed: Promise<void> = Promise.resolve();
  try {
    await mkdir(join(workspace, ".agents"), { recursive: true });
    const nonce = crypto.randomUUID();
    await writeFile(join(workspace, ".agents", "guard.cjs"), `const fs=require('node:fs');const r=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync('../guard.jsonl',JSON.stringify({nonce:${JSON.stringify(nonce)},conversation:r.conversationId,denied:!!r.toolCall})+'\\n');if(r.toolCall)process.stdout.write(JSON.stringify({decision:'deny',reason:'Claude Code owns all tool execution.'}));`);
    const hook = `${shellQuote(process.execPath)} guard.cjs`;
    await writeFile(join(workspace, ".agents", "hooks.json"), JSON.stringify({ "gateway-native-deny": { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hook, timeout: 30 }] }], PreInvocation: [{ command: hook }] } }));

    const args = [ "--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands"];
    if (model) args.push("--model", model);
    if (env.AGY_GATEWAY_EFFORT) args.push("--effort", env.AGY_GATEWAY_EFFORT);
    const result = await new Promise<{ output: any; model: string; conversation: string }>((resolve, reject) => {
      const child = spawn(env.AGY_GATEWAY_BIN || "agy", args, { cwd: workspace, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "ignore"] });
      closed = new Promise((done) => child.once("close", () => done()));
      let buffer = "", conversation = "", actualModel = "", terminal = false, settled = false;
      let validated: { output: any; model: string; conversation: string } | undefined;
      const finish = (error?: Error, value?: any) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        terminate(child);
        child.stdin?.destroy();
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(new Error("AGY request cancelled or timed out."));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const consume = (line: string) => {
        const row = JSON.parse(line);
        if (terminal) throw new Error("AGY emitted a late event.");
        if (row.event === "init") {
          if (conversation || typeof row.conversation_id !== "string" || !row.conversation_id || !row.init || (row.init.model !== undefined && typeof row.init.model !== "string")) throw new Error("Invalid AGY initialization.");
          conversation = row.conversation_id; actualModel = row.init.model || model || "agy";
          if (model && actualModel !== model) throw new Error("AGY model does not match configuration.");
          child.stdin!.write(JSON.stringify({ event: "user", message: { content: `${instruction}\nREQUEST:\n${JSON.stringify(prompt)}` } }) + "\n");
        } else if (row.event === "step_update") {
          const step = row.step_update;
          if (!conversation || step?.conversation_id !== conversation || !["user_input", "agent_response"].includes(step.step_type)) throw new Error("AGY attempted native execution or emitted an uncorrelated step.");
        } else if (row.event === "result") {
          const result = row.result;
          if (!conversation || result?.conversation_id !== conversation || result.status !== "SUCCESS" || result.num_turns !== 1) throw new Error("AGY returned an unsuccessful or uncorrelated result.");
          const output = result.structured_output ?? JSON.parse(result.response);
          if (!output || Object.keys(output).some((key) => !["text", "tool_calls"].includes(key)) || typeof output.text !== "string" || !Array.isArray(output.tool_calls) || (!output.text && !output.tool_calls.length)) throw new Error("AGY returned malformed structured output.");
          terminal = true;
          child.stdin!.end();
          validated = { output, model: actualModel, conversation };
        } else throw new Error("Unknown AGY protocol event.");
      };
      child.stdout!.on("data", (data) => {
        if (settled) return;
        try {
          buffer += data.toString();
          if (buffer.length > 8_000_000) throw new Error("AGY protocol output exceeded the limit.");
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (line) consume(line); }
          if (terminal && buffer.trim()) throw new Error("AGY emitted trailing protocol data.");
        } catch { finish(new Error("AGY protocol validation failed.")); }
      });
      child.stdin!.on("error", () => finish(new Error("AGY input channel failed.")));
      child.on("error", () => finish(new Error("AGY executable is unavailable.")));
      child.on("close", (code) => {
        if (code === 0 && terminal && validated && !buffer.trim()) finish(undefined, validated);
        else finish(new Error("AGY ended without a valid result; check native authentication."));
      });
    });
    await closed;
    const proof = (await readFile(join(workspace, "guard.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    if (!proof.length || proof.some((row) => row.nonce !== nonce || row.conversation !== result.conversation || row.denied)) throw new Error("AGY native execution guard was not confirmed.");
    return { output: result.output, model: result.model };
  } finally { await closed; await rm(workspace, { recursive: true, force: true }); }
}

export function agyPrompt(request: AnthropicMessagesRequest, current: { text: string; results: unknown[] }) {
  return { system: request.system, history: request.messages.slice(0, -1), current_user_text: current.text, current_tool_results: current.text ? [] : current.results, external_tools: request.tools ?? [] };
}
