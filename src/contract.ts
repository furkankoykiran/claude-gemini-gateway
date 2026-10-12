import type { AnthropicMessagesRequest, AnthropicContentBlockToolResult, AnthropicContentBlockToolUse } from "./types.ts";

export function actionableText(text: string): string {
  const clean = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  return clean.startsWith("<system-reminder>") ? "" : clean;
}

export function currentTurn(request: AnthropicMessagesRequest) {
  if (!request || !Array.isArray(request.messages) || !request.messages.length) throw new Error("messages must be a non-empty array.");
  for (const message of request.messages) {
    if (!message || !["user", "assistant", "system"].includes(message.role)) throw new Error("Unsupported message role.");
    if (typeof message.content !== "string" && !Array.isArray(message.content)) throw new Error("Unsupported message content.");
    if (Array.isArray(message.content)) for (const block of message.content) {
      if (!block || !["text", "tool_use", "tool_result"].includes(block.type)) throw new Error("Unsupported content block.");
      if (block.type === "text" && typeof block.text !== "string") throw new Error("Invalid text block.");
      if (block.type === "tool_use" && (message.role !== "assistant" || !block.id || !block.name || !block.input || typeof block.input !== "object" || Array.isArray(block.input))) throw new Error("Invalid assistant tool use.");
      if (block.type === "tool_result" && (message.role !== "user" || !block.tool_use_id || (typeof block.content !== "string" && (!Array.isArray(block.content) || block.content.some((part) => part.type !== "text" || typeof part.text !== "string"))))) throw new Error("Invalid user tool result.");
    }
  }
  const current = request.messages.findLast((message) => message.role !== "system");
  if (current?.role !== "user") throw new Error("No current user turn.");
  const text = actionableText(typeof current.content === "string" ? current.content : current.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"));
  const results = !text && Array.isArray(current.content) ? current.content.filter((block): block is AnthropicContentBlockToolResult => block.type === "tool_result") : [];
  if (!text && !results.length) throw new Error("No actionable current user text or pending tool result; refusing reminder-only inference.");
  return { text, results };
}

type Cycle = { session: string | null; model: string; calls: AnthropicContentBlockToolUse[]; parts: any[]; deadline: ReturnType<typeof setTimeout> };

/** Google has no app-server thread. A local response cycle binds issued IDs to a session/model and expires as a unit. */
export class ToolCycles {
  private readonly pending = new Map<string, Cycle>();
  constructor(private readonly timeoutMs: number) {}

  claim(request: AnthropicMessagesRequest, session: string | null, model: string): Map<string, any> {
    const current = currentTurn(request);
    if (current.text) {
      // Only structured history identifies superseded cycles. A separate classifier must not consume them.
      for (const message of request.messages) if (Array.isArray(message.content)) for (const block of message.content) {
        const id = block.type === "tool_result" ? block.tool_use_id : block.type === "tool_use" ? block.id : undefined;
        const cycle = id ? this.pending.get(id) : undefined;
        if (cycle?.session === session) this.forget(cycle);
      }
      return new Map();
    }
    const ids = current.results.map((result) => result.tool_use_id);
    const cycle = this.pending.get(ids[0]!);
    if (!cycle || cycle.session !== session || cycle.model !== model || new Set(ids).size !== ids.length || ids.length !== cycle.calls.length || ids.some((id) => this.pending.get(id) !== cycle)) throw new Error("Tool results do not match one complete pending cycle in this session/model.");
    const assistant = request.messages.slice(0, request.messages.findLastIndex((message) => message.role !== "system")).findLast((message) => message.role === "assistant");
    const calls = Array.isArray(assistant?.content) ? assistant.content.filter((block) => block.type === "tool_use") : [];
    if (calls.length !== cycle.calls.length || cycle.calls.some((issued) => !calls.some((call) => call.id === issued.id && call.name === issued.name && JSON.stringify(call.input) === JSON.stringify(issued.input)))) throw new Error("Tool history differs from the issued cycle.");
    const parts = new Map(cycle.calls.map((call, index) => [call.id, cycle.parts[index]]));
    this.forget(cycle); // Claim atomically before the first network await; duplicates cannot replay it.
    return parts;
  }

  issue(calls: AnthropicContentBlockToolUse[], parts: any[], session: string | null, model: string) {
    if (!calls.length) return;
    const cycle: Cycle = { session, model, calls: structuredClone(calls), parts: structuredClone(parts), deadline: setTimeout(() => this.forget(cycle), this.timeoutMs) };
    cycle.deadline.unref();
    for (const call of calls) this.pending.set(call.id, cycle);
  }

  private forget(cycle: Cycle) {
    clearTimeout(cycle.deadline);
    for (const call of cycle.calls) this.pending.delete(call.id);
  }

  clear() { for (const cycle of this.pending.values()) this.forget(cycle); }
}
