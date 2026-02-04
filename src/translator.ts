// Translator: Converts between Anthropic API format and OpenAI/Codex API format

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result";
  text?: string;
  source?: {
    type: "base64";
    media_type: string;
    data: string;
  };
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  system?: string;
  tools?: AnthropicTool[];
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

// OpenAI/Codex format
export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentBlock[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIContentBlock {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: OpenAITool[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  user?: string;
  // Codex-specific fields
  instructions?: string;
  store?: boolean;
}

export interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: OpenAIMessage;
    finish_reason: "stop" | "length" | "tool_calls" | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
    delta: Partial<OpenAIMessage>;
    finish_reason: "stop" | "length" | "tool_calls" | null;
  }[];
}

// Model mapping
const MODEL_MAP: Record<string, string> = {
  "claude-sonnet-4-5-20250929": "gpt-5.2-codex",
  "claude-opus-4-5-20250929": "gpt-5.2-codex",
  "claude-haiku-4-5-20250929": "gpt-5.1-codex-mini",
  "claude-3-5-sonnet-20241022": "gpt-5.2-codex",
  "claude-3-opus-20240229": "gpt-5.2-codex",
  "claude-3-haiku-20240307": "gpt-5.1-codex-mini",
  // Default fallback
  default: "gpt-5.2-codex",
};

export function mapModel(anthropicModel: string): string {
  return MODEL_MAP[anthropicModel] || MODEL_MAP.default;
}

export function translateAnthropicToOpenAI(
  anthropicReq: AnthropicRequest,
  codexInstructions?: string
): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // Add system message if present
  if (anthropicReq.system) {
    messages.push({
      role: "system",
      content: anthropicReq.system,
    });
  }

  // Convert messages
  for (const msg of anthropicReq.messages) {
    if (typeof msg.content === "string") {
      messages.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      });
    } else {
      // Handle content blocks (for now, just extract text)
      const textContent = msg.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");

      messages.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: textContent,
      });
    }
  }

  const openAIReq: OpenAIRequest = {
    model: mapModel(anthropicReq.model),
    messages,
    stream: anthropicReq.stream ?? true,
    store: false, // Codex-specific
  };

  // Add optional parameters
  if (anthropicReq.max_tokens !== undefined) {
    openAIReq.max_tokens = anthropicReq.max_tokens;
  }
  if (anthropicReq.temperature !== undefined) {
    openAIReq.temperature = anthropicReq.temperature;
  }
  if (anthropicReq.top_p !== undefined) {
    openAIReq.top_p = anthropicReq.top_p;
  }

  // Add Codex instructions if provided
  if (codexInstructions) {
    openAIReq.instructions = codexInstructions;
  }

  // Note: Tools are disabled for basic chat as per requirements
  // if (anthropicReq.tools) {
  //   openAIReq.tools = translateTools(anthropicReq.tools);
  // }

  return openAIReq;
}

export function translateOpenAIToAnthropic(openAIResp: OpenAIResponse): {
  content: AnthropicContentBlock[];
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | null;
  usage?: { input_tokens: number; output_tokens: number };
} {
  const choice = openAIResp.choices[0];
  if (!choice) {
    return { content: [], stop_reason: null };
  }

  const content: AnthropicContentBlock[] = [];

  // Handle string content
  if (typeof choice.message.content === "string") {
    content.push({ type: "text", text: choice.message.content });
  } else if (Array.isArray(choice.message.content)) {
    // Handle array content blocks
    for (const block of choice.message.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text || "" });
      }
    }
  }

  // Map finish reason
  let stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | null = null;
  if (choice.finish_reason === "stop") {
    stop_reason = "end_turn";
  } else if (choice.finish_reason === "length") {
    stop_reason = "max_tokens";
  }

  return {
    content,
    stop_reason,
    usage: openAIResp.usage
      ? {
          input_tokens: openAIResp.usage.prompt_tokens,
          output_tokens: openAIResp.usage.completion_tokens,
        }
      : undefined,
  };
}

export function translateOpenAIStreamChunk(chunk: OpenAIStreamChunk): {
  type: "content_block_delta" | "message_stop";
  delta?: { text: string };
} | null {
  const choice = chunk.choices[0];
  if (!choice) return null;

  // Handle finish
  if (choice.finish_reason) {
    return { type: "message_stop" };
  }

  // Handle content delta
  if (choice.delta.content) {
    return {
      type: "content_block_delta",
      delta: { text: typeof choice.delta.content === "string" ? choice.delta.content : "" },
    };
  }

  return null;
}

// SSE formatting helpers
export function createAnthropicStreamEvent(
  eventType: string,
  data: unknown
): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createOpenAIStreamChunk(chunk: OpenAIStreamChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// Codex-specific system prompt
export const CODEX_SYSTEM_INSTRUCTIONS = `You are a coding agent running in a terminal-based coding assistant. You are expected to be precise, safe, and helpful.`;
