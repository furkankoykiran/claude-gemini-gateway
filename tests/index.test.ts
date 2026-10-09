import { describe, expect, it, afterAll, beforeAll } from "bun:test";
import {
  translateAnthropicToGemini,
  translateGeminiToAnthropic,
  resolveGeminiModel,
} from "../src/translate.ts";
import { resolveGoogleCredentials, detectConsumerOAuth } from "../src/auth.ts";
import { createGatewayServer } from "../src/server.ts";
import type { AnthropicMessagesRequest } from "../src/types.ts";

describe("claude-gemini-gateway: translation & mapping", () => {
  it("resolves model names correctly", () => {
    expect(resolveGeminiModel("claude-3-5-sonnet-latest")).toBe("gemini-3.8-flash");
    expect(resolveGeminiModel("gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(resolveGeminiModel("gemini-3.8-flash")).toBe("gemini-3.8-flash");
    expect(resolveGeminiModel("custom", { GEMINI_MODEL: "gemini-2.5-flash" } as any)).toBe(
      "gemini-2.5-flash"
    );
  });

  it("translates Anthropic messages and system instructions to Gemini format", () => {
    const req: AnthropicMessagesRequest = {
      model: "gemini-3.8-flash",
      system: "You are a helpful coding assistant.",
      messages: [
        { role: "user", content: "Write a function" },
        { role: "assistant", content: "function foo() {}" },
        { role: "user", content: "Now test it" },
      ],
    };

    const geminiReq = translateAnthropicToGemini(req);
    expect(geminiReq.systemInstruction?.parts[0]?.text).toBe("You are a helpful coding assistant.");
    expect(geminiReq.contents.length).toBe(3);
    expect(geminiReq.contents[0].role).toBe("user");
    expect(geminiReq.contents[0].parts[0].text).toBe("Write a function");
    expect(geminiReq.contents[1].role).toBe("model");
    expect(geminiReq.contents[1].parts[0].text).toBe("function foo() {}");
    expect(geminiReq.contents[2].role).toBe("user");
  });

  it("translates tools, tool_use, and tool_result blocks", () => {
    const req: AnthropicMessagesRequest = {
      model: "gemini-3.8-flash",
      messages: [
        { role: "user", content: "Check the weather" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_weather_1",
              name: "get_weather",
              input: { city: "Berlin" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_weather_1",
              content: "Sunny, 20C",
            },
          ],
        },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Get city weather",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
    };

    const geminiReq = translateAnthropicToGemini(req);
    expect(geminiReq.tools?.length).toBe(1);
    expect(geminiReq.tools![0].functionDeclarations[0].name).toBe("get_weather");

    // Check assistant turn tool_use -> functionCall
    const assistantTurn = geminiReq.contents[1];
    expect(assistantTurn.role).toBe("model");
    expect((assistantTurn.parts[0] as any).functionCall.name).toBe("get_weather");
    expect((assistantTurn.parts[0] as any).functionCall.args.city).toBe("Berlin");

    // Check user turn tool_result -> functionResponse
    const userResultTurn = geminiReq.contents[2];
    expect(userResultTurn.role).toBe("user");
    expect((userResultTurn.parts[0] as any).functionResponse.name).toBe("get_weather");
    expect((userResultTurn.parts[0] as any).functionResponse.response.content).toBe("Sunny, 20C");
  });

  it("translates Gemini response to Anthropic message format", () => {
    const geminiRes = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "Hello! How can I help you?" }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 8,
      },
    };

    const anthropicMsg = translateGeminiToAnthropic(geminiRes, "gemini-3.8-flash");
    expect(anthropicMsg.role).toBe("assistant");
    expect(anthropicMsg.stop_reason).toBe("end_turn");
    expect((anthropicMsg.content as any)[0].type).toBe("text");
    expect((anthropicMsg.content as any)[0].text).toBe("Hello! How can I help you?");
    expect((anthropicMsg.usage as any).input_tokens).toBe(12);
    expect((anthropicMsg.usage as any).output_tokens).toBe(8);
  });

  it("translates Gemini functionCall candidate to Anthropic tool_use block", () => {
    const geminiRes = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "execute_command",
                  args: { cmd: "ls -la" },
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 20,
        candidatesTokenCount: 15,
      },
    };

    const anthropicMsg = translateGeminiToAnthropic(geminiRes, "gemini-3.8-flash");
    expect(anthropicMsg.stop_reason).toBe("tool_use");
    const block = (anthropicMsg.content as any)[0];
    expect(block.type).toBe("tool_use");
    expect(block.name).toBe("execute_command");
    expect(block.input.cmd).toBe("ls -la");
  });
});

describe("claude-gemini-gateway: policy safety & auth", () => {
  it("resolves valid GEMINI_API_KEY", () => {
    const creds = resolveGoogleCredentials({ GEMINI_API_KEY: "AIzaSyValidKey" } as any);
    expect(creds.kind).toBe("api-key");
    expect(creds.apiKey).toBe("AIzaSyValidKey");
  });

  it("resolves valid Vertex AI credentials", () => {
    const creds = resolveGoogleCredentials({
      ANTHROPIC_VERTEX_PROJECT_ID: "my-project",
      CLOUD_ML_REGION: "us-central1",
    } as any);
    expect(creds.kind).toBe("vertex");
    expect(creds.project).toBe("my-project");
    expect(creds.location).toBe("us-central1");
  });

  it("strictly rejects consumer Antigravity OAuth and suggests native agy", () => {
    expect(() =>
      resolveGoogleCredentials({
        ANTIGRAVITY_AGENT: "1",
      } as any)
    ).toThrow("Personal Antigravity consumer OAuth cannot be reused");
  });

  it("fails closed on missing credentials", () => {
    expect(() => resolveGoogleCredentials({} as any)).toThrow("No supported Google credentials found");
  });
});

describe("claude-gemini-gateway: HTTP endpoints", () => {
  const TEST_PORT = 4149;
  let server: any;

  beforeAll(() => {
    server = createGatewayServer({
      port: TEST_PORT,
      host: "127.0.0.1",
      env: { GEMINI_API_KEY: "AIzaMockKey" } as any,
    });
  });

  afterAll(() => {
    server?.stop();
  });

  it("responds to /health with status ok", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.status).toBe("ok");
    expect(body.provider).toBe("gemini");
  });

  it("responds to /v1/models with model list", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/models`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.some((m: any) => m.id === "gemini-3.8-flash")).toBe(true);
  });

  it("returns 401 when consumer OAuth is presented without official credentials", async () => {
    const lockedServer = createGatewayServer({
      port: 4150,
      host: "127.0.0.1",
      env: { ANTIGRAVITY_AGENTAPI_EXE: "/path/to/exe" } as any,
    });

    try {
      const res = await fetch("http://127.0.0.1:4150/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gemini-3.8-flash",
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      expect(res.status).toBe(401);
      const json: any = await res.json();
      expect(json.error.message).toContain("Personal Antigravity consumer OAuth cannot be reused");
      expect(json.error.message).toContain("agy -p");
    } finally {
      lockedServer.stop();
    }
  });
});
