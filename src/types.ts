export interface AnthropicContentBlockText {
  type: "text";
  text: string;
}

export interface AnthropicContentBlockToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicContentBlockToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<AnthropicContentBlockText>;
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicContentBlockText
  | AnthropicContentBlockToolUse
  | AnthropicContentBlockToolResult;

export interface AnthropicMessage {
  role: "user" | "assistant" | "system";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: "text"; text: string }>;
  max_tokens?: number;
  temperature?: number;
  tools?: AnthropicTool[];
  stream?: boolean;
  metadata?: Record<string, unknown>;
}

export interface GeminiPartText {
  text: string;
}

export interface GeminiPartFunctionCall {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
  };
}

export interface GeminiPartFunctionResponse {
  functionResponse: {
    name: string;
    response: {
      content: unknown;
    };
  };
}

export type GeminiPart =
  | GeminiPartText
  | GeminiPartFunctionCall
  | GeminiPartFunctionResponse;

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiTool {
  functionDeclarations: GeminiFunctionDeclaration[];
}

export interface GeminiGenerateContentRequest {
  contents: GeminiContent[];
  systemInstruction?: {
    parts: Array<{ text: string }>;
  };
  tools?: GeminiTool[];
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
  };
}
