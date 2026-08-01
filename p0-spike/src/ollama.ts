export const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  tool_name?: string;
}

export interface ChatResult {
  message: ChatMessage;
  malformedToolCall: boolean;
  malformedDetail?: string;
  latencyMs: number;
}

export async function chat(model: string, messages: ChatMessage[], tools: readonly unknown[]): Promise<ChatResult> {
  const start = Date.now();
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      tools,
      stream: false,
      options: { num_ctx: 8192 },
    }),
  });

  const latencyMs = Date.now() - start;

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ollama /api/chat ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { message: ChatMessage };
  const message = data.message;

  // Ollama pre-parses tool call arguments into objects for compliant models,
  // but some models emit malformed JSON as raw content instead of a proper
  // tool_calls entry. Treat "no tool_calls and no finish signal" content that
  // looks like an attempted tool call as a malformed call for measurement.
  let malformedToolCall = false;
  let malformedDetail: string | undefined;
  if ((!message.tool_calls || message.tool_calls.length === 0) && /"(name|function|tool)"/.test(message.content ?? "")) {
    malformedToolCall = true;
    malformedDetail = `model emitted tool-call-shaped text in content instead of tool_calls: ${message.content.slice(0, 200)}`;
  }

  return { message, malformedToolCall, malformedDetail, latencyMs };
}

export async function listLocalModels(): Promise<string[]> {
  const res = await fetch(`${OLLAMA_HOST}/api/tags`);
  if (!res.ok) throw new Error(`ollama /api/tags ${res.status}`);
  const data = (await res.json()) as { models: Array<{ name: string }> };
  return data.models.map((m) => m.name);
}
