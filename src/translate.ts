import type {
  AnthropicMessagesRequest,
  AnthropicMessage,
  AnthropicContentBlock,
  GeminiGenerateContentRequest,
  GeminiContent,
  GeminiPart,
} from "./types.ts";

export function resolveGeminiModel(model: string, env = process.env): string {
  if (env["GEMINI_MODEL"]) return env["GEMINI_MODEL"];
  if (model.startsWith("gemini-")) return model;
  if (model.includes("flash")) return "gemini-3.8-flash";
  if (model.includes("pro")) return "gemini-2.5-pro";
  return "gemini-3.8-flash";
}

export function translateAnthropicToGemini(
  request: AnthropicMessagesRequest
): GeminiGenerateContentRequest {
  let systemText = "";
  if (typeof request.system === "string") {
    systemText = request.system;
  } else if (Array.isArray(request.system)) {
    systemText = request.system.map((s) => s.text).join("\n\n");
  }

  const toolNameById = new Map<string, string>();
  const contents: GeminiContent[] = [];

  for (const msg of request.messages) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      systemText = systemText ? `${systemText}\n\n${text}` : text;
      continue;
    }

    const geminiRole: "user" | "model" = msg.role === "assistant" ? "model" : "user";
    const parts: GeminiPart[] = [];

    if (typeof msg.content === "string") {
      if (msg.content.trim().length > 0) {
        parts.push({ text: msg.content });
      }
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length > 0) {
            parts.push({ text: block.text });
          }
        } else if (block.type === "tool_use") {
          toolNameById.set(block.id, block.name);
          parts.push({
            functionCall: {
              name: block.name,
              args: block.input ?? {},
            },
          });
        } else if (block.type === "tool_result") {
          const fnName = toolNameById.get(block.tool_use_id) || "tool";
          const resContent =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
              ? block.content.map((c) => c.text).join("\n")
              : JSON.stringify(block.content);

          parts.push({
            functionResponse: {
              name: fnName,
              response: {
                content: resContent,
              },
            },
          });
        }
      }
    }

    if (parts.length === 0) {
      parts.push({ text: " " });
    }

    // Merge consecutive messages with the same role
    const lastContent = contents[contents.length - 1];
    if (lastContent && lastContent.role === geminiRole) {
      lastContent.parts.push(...parts);
    } else {
      contents.push({
        role: geminiRole,
        parts,
      });
    }
  }

  // Ensure first turn is user if contents exist
  if (contents.length > 0 && contents[0].role !== "user") {
    contents.unshift({
      role: "user",
      parts: [{ text: "Hello" }],
    });
  }

  const result: GeminiGenerateContentRequest = {
    contents,
    generationConfig: {
      maxOutputTokens: request.max_tokens ?? 8192,
      temperature: request.temperature ?? 0.7,
    },
  };

  if (systemText.trim().length > 0) {
    result.systemInstruction = {
      parts: [{ text: systemText }],
    };
  }

  if (request.tools && request.tools.length > 0) {
    result.tools = [
      {
        functionDeclarations: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        })),
      },
    ];
  }

  return result;
}

export function translateGeminiToAnthropic(
  geminiResponse: any,
  model: string
): Record<string, unknown> {
  const candidate = geminiResponse?.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const contentBlocks: AnthropicContentBlock[] = [];
  let hasFunctionCall = false;

  for (const part of parts) {
    if (part.text !== undefined) {
      contentBlocks.push({
        type: "text",
        text: part.text,
      });
    } else if (part.functionCall) {
      hasFunctionCall = true;
      contentBlocks.push({
        type: "tool_use",
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      });
    }
  }

  if (contentBlocks.length === 0) {
    contentBlocks.push({
      type: "text",
      text: "",
    });
  }

  const stopReason = hasFunctionCall
    ? "tool_use"
    : candidate?.finishReason === "MAX_TOKENS"
    ? "max_tokens"
    : "end_turn";

  const usage = {
    input_tokens: geminiResponse?.usageMetadata?.promptTokenCount ?? 0,
    output_tokens: geminiResponse?.usageMetadata?.candidatesTokenCount ?? 0,
  };

  return {
    id: `msg_${Math.random().toString(36).slice(2, 14)}`,
    type: "message",
    role: "assistant",
    model,
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}
