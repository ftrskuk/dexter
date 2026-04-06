import { randomUUID } from 'node:crypto';

import { AIMessage, AIMessageChunk, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';

import { getOpenAICodexRequestHeaders, getValidOpenAICodexAuth } from '@/utils/openai-codex-oauth';

const OPENAI_CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_MAX_INSTRUCTIONS_BYTES = 30_000;

type CodexContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string };

type CodexInputItem =
  | { role: 'user'; content: string | CodexContentPart[] }
  | { role: 'assistant'; content: string }
  | { role: 'system'; content: string }
  | { type: 'function_call'; id?: string; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

type CodexOutputItem =
  | {
      type: 'message';
      role?: string;
      content?: Array<{
        type?: string;
        text?: string;
      }>;
    }
  | {
      type: 'function_call';
      id?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
    };

interface CodexResponsePayload {
  output?: CodexOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

interface CodexCallOptions {
  model: string;
  messages: BaseMessage[];
  tools?: StructuredToolInterface[];
  signal?: AbortSignal;
}

function trimInstructions(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= CODEX_MAX_INSTRUCTIONS_BYTES) {
    return text;
  }

  let trimmed = text;
  while (Buffer.byteLength(`${trimmed}\n\n[Truncated for OpenAI Codex compatibility]`, 'utf8') > CODEX_MAX_INSTRUCTIONS_BYTES && trimmed.length > 0) {
    trimmed = trimmed.slice(0, Math.floor(trimmed.length * 0.9));
  }

  return `${trimmed}\n\n[Truncated for OpenAI Codex compatibility]`;
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') {
          return block;
        }

        if (block && typeof block === 'object') {
          const candidate = block as { text?: string; type?: string };
          if (typeof candidate.text === 'string') {
            return candidate.text;
          }
        }

        return JSON.stringify(block);
      })
      .join('\n');
  }

  return String(content ?? '');
}

function getToolJsonSchema(tool: StructuredToolInterface): Record<string, unknown> {
  const schemaCandidate = (tool as { schema?: unknown }).schema;
  if (schemaCandidate && typeof schemaCandidate === 'object') {
    const zodSchema = schemaCandidate as { toJSONSchema?: () => Record<string, unknown> };
    if (typeof zodSchema.toJSONSchema === 'function') {
      return zodSchema.toJSONSchema();
    }
  }

  return z.toJSONSchema(z.object({})) as Record<string, unknown>;
}

function convertTools(tools: StructuredToolInterface[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: getToolJsonSchema(tool),
  }));
}

function convertMessages(messages: BaseMessage[]): { instructions?: string; input: CodexInputItem[] } {
  const instructions: string[] = [];
  const input: CodexInputItem[] = [];

  for (const message of messages) {
    if (message instanceof SystemMessage) {
      instructions.push(stringifyMessageContent(message.content));
      continue;
    }

    if (message instanceof HumanMessage) {
      const text = stringifyMessageContent(message.content);
      input.push({
        role: 'user',
        content: [{ type: 'input_text', text }],
      });
      continue;
    }

    if (message instanceof ToolMessage) {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: stringifyMessageContent(message.content),
      });
      continue;
    }

    if (AIMessage.isInstance(message)) {
      const assistantText = stringifyMessageContent(message.content).trim();
      if (assistantText) {
        input.push({ role: 'assistant', content: assistantText });
      }

      if (Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
          input.push({
            type: 'function_call',
            id: toolCall.id,
            call_id: toolCall.id ?? randomUUID(),
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.args ?? {}),
          });
        }
      }

      continue;
    }

    input.push({
      role: 'user',
      content: [{ type: 'input_text', text: stringifyMessageContent(message.content) }],
    });
  }

  const mergedInstructions = instructions.join('\n\n').trim();
  return {
    instructions: mergedInstructions ? trimInstructions(mergedInstructions) : undefined,
    input,
  };
}

function parseToolCall(item: Extract<CodexOutputItem, { type: 'function_call' }>) {
  if (!item.name || !item.arguments) {
    return null;
  }

  try {
    return {
      id: item.call_id ?? item.id ?? randomUUID(),
      name: item.name,
      args: JSON.parse(item.arguments) as Record<string, unknown>,
      type: 'tool_call' as const,
    };
  } catch {
    return null;
  }
}

function parseCodexResponse(response: CodexResponsePayload): AIMessage {
  const texts: string[] = [];
  const toolCalls: Array<{ id?: string; name: string; args: Record<string, unknown>; type?: 'tool_call' }> = [];

  for (const item of response.output ?? []) {
    if (item.type === 'message') {
      for (const block of item.content ?? []) {
        if (typeof block.text === 'string' && block.text.trim()) {
          texts.push(block.text);
        }
      }
      continue;
    }

    if (item.type === 'function_call') {
      const parsedToolCall = parseToolCall(item);
      if (parsedToolCall) {
        toolCalls.push(parsedToolCall);
      }
    }
  }

  return new AIMessage({
    content: texts.join('\n').trim(),
    tool_calls: toolCalls,
    usage_metadata: response.usage
      ? {
          input_tokens: response.usage.input_tokens ?? 0,
          output_tokens: response.usage.output_tokens ?? 0,
          total_tokens: response.usage.total_tokens ?? 0,
        }
      : undefined,
    response_metadata: response as Record<string, unknown>,
  });
}

function parseSseEventBlock(block: string): { event?: string; data?: string } | null {
  const trimmed = block.trim();
  if (!trimmed) {
    return null;
  }

  const lines = trimmed.split('\n');
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
  }

  return { event, data: dataLines.join('\n') };
}

async function readCodexSseResponse(response: Response): Promise<AIMessage> {
  if (!response.body) {
    throw new Error('[OpenAI Codex API] Empty response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let finalResponse: CodexResponsePayload | null = null;
  let latestOutputItems: CodexOutputItem[] = [];
  let latestUsage: CodexResponsePayload['usage'];
  const reader = response.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';

    for (const block of blocks) {
      const parsedBlock = parseSseEventBlock(block);
      if (!parsedBlock?.data || parsedBlock.data === '[DONE]') {
        continue;
      }

      try {
        const payload = JSON.parse(parsedBlock.data) as Record<string, unknown>;
        const eventType = parsedBlock.event ?? (typeof payload.type === 'string' ? payload.type : undefined);
        const responsePayload = payload.response as CodexResponsePayload | undefined;
        if (eventType === 'response.completed' && responsePayload) {
          finalResponse = responsePayload;
          continue;
        }

        const item = payload.item as CodexOutputItem | undefined;
        if (item && (item.type === 'message' || item.type === 'function_call')) {
          const existingIndex = latestOutputItems.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(item));
          if (existingIndex === -1) {
            latestOutputItems.push(item);
          }
        }

        if (payload.response && typeof payload.response === 'object') {
          const candidate = payload.response as CodexResponsePayload;
          if (candidate.output) {
            latestOutputItems = candidate.output;
          }
          if (candidate.usage) {
            latestUsage = candidate.usage;
          }
        }
      } catch {
      }
    }
  }

  const effectiveResponse = finalResponse ?? { output: latestOutputItems, usage: latestUsage };
  return parseCodexResponse(effectiveResponse);
}

export async function callOpenAICodex(options: CodexCallOptions): Promise<AIMessage> {
  const auth = await getValidOpenAICodexAuth();
  const { instructions, input } = convertMessages(options.messages);
  const tools = convertTools(options.tools);

  const requestBody: Record<string, unknown> = {
    model: options.model.replace(/^openai-codex:/, ''),
    input,
    stream: true,
    store: false,
  };

  if (instructions) {
    requestBody.instructions = instructions;
  }

  if (tools && tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = 'auto';
    requestBody.parallel_tool_calls = true;
  }

  const response = await fetch(OPENAI_CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: {
      ...getOpenAICodexRequestHeaders(auth),
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'responses_websockets=2026-02-06',
      'x-openai-internal-codex-residency': 'us',
      'x-client-request-id': randomUUID(),
    },
    body: JSON.stringify(requestBody),
    signal: options.signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`[OpenAI Codex API] ${response.status} status code${errorText ? `: ${errorText}` : ' (no body)'}`);
  }

  return readCodexSseResponse(response);
}

export async function* streamOpenAICodex(options: CodexCallOptions): AsyncGenerator<AIMessageChunk, void> {
  const response = await callOpenAICodex(options);
  yield new AIMessageChunk({
    content: response.content,
    tool_calls: response.tool_calls,
    invalid_tool_calls: response.invalid_tool_calls,
    usage_metadata: response.usage_metadata,
    response_metadata: response.response_metadata,
  });
}
