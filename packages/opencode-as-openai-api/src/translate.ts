import { randomUUID } from "node:crypto";

const HTTP_BAD_REQUEST_STATUS = 400;
const HTTP_NOT_FOUND_STATUS = 404;
const HTTP_BAD_GATEWAY_STATUS = 502;
const MILLISECONDS_PER_SECOND = 1_000;
const FUNCTION_CALL_OUTPUT_KEYS = ["arguments", "name", "type"];
const TEXT_OUTPUT_KEYS = ["text", "type"];
const MESSAGE_ROLES = new Set(["system", "developer", "user", "assistant"]);
const CHAT_MESSAGE_ROLES = new Set([...MESSAGE_ROLES, "tool"]);
const TEXT_CONTENT_TYPES = new Set(["input_text", "output_text", "text"]);
const FUNCTION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MODEL_NAME_PATTERN = /^[^/\s]+\/\S+$/;

type UnknownRecord = Record<string, unknown>;
export type ToolChoiceMode = "auto" | "none" | "required";

export interface ModelIdentifier {
  providerID: string;
  modelID: string;
}

export interface NormalizedTool {
  name: string;
  description: string;
  parameters: UnknownRecord;
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface TranscriptEntry {
  role: string;
  content?: string;
  function_call?: {
    call_id: string;
    name: string;
    arguments: string;
  };
  call_id?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface NormalizedRequest {
  kind: "responses" | "chat";
  stream: boolean;
  transcript: TranscriptEntry[];
  tools: NormalizedTool[];
  toolChoice: {
    mode: ToolChoiceMode;
    names: string[];
  };
}

export interface ResultSchema {
  type: "object";
  oneOf: UnknownRecord[];
}

export interface OpenCodeRequestBody {
  model: ModelIdentifier;
  agent: "opencode-as-openai-api";
  parts: [{ type: "text"; text: string }];
  tools: Record<string, false>;
  variant?: string;
  format?: {
    type: "json_schema";
    schema: ResultSchema;
    retryCount: number;
  };
}

export interface StructuredOutputPolicy {
  allowText: boolean;
  allowedFunctionNames: readonly string[];
}

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  total: number;
}

export type OpenCodeResult =
  | { type: "text"; text: string; usage: TokenUsage }
  | { type: "function_call"; name: string; arguments: string; callId: string; usage: TokenUsage };

export type ResponseOutputItem =
  | {
    type: "message";
    id: string;
    status: "completed";
    role: "assistant";
    content: [{ type: "output_text"; text: string; annotations: [] }];
  }
  | {
    type: "function_call";
    id: string;
    call_id: string;
    name: string;
    arguments: string;
    status: "completed";
  };

export interface ResponsesApiObject {
  id: string;
  object: "response";
  created_at: number;
  status: "completed";
  completed_at: number;
  error: null;
  incomplete_details: null;
  instructions: null;
  max_output_tokens: null;
  model: string;
  output: [ResponseOutputItem];
  parallel_tool_calls: false;
  previous_response_id: null;
  reasoning: { effort: null; summary: null };
  store: false;
  temperature: number;
  text: { format: { type: "text" } };
  tool_choice: "auto";
  tools: [];
  top_p: number;
  truncation: "disabled";
  usage: {
    input_tokens: number;
    output_tokens: number;
    output_tokens_details: { reasoning_tokens: number };
    total_tokens: number;
  };
  user: null;
  metadata: UnknownRecord;
}

type ChatMessage =
  | { role: "assistant"; content: string; refusal: null }
  | {
    role: "assistant";
    content: null;
    tool_calls: [{ id: string; type: "function"; function: { name: string; arguments: string } }];
  };

export interface ChatCompletionObject {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: [{
    index: 0;
    message: ChatMessage;
    logprobs: null;
    finish_reason: "tool_calls" | "stop";
  }];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details: { reasoning_tokens: number };
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly param: string | null;
  readonly code: string | null;

  constructor(
    status: number,
    message: string,
    type = "invalid_request_error",
    param: string | null = null,
    code: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.type = type;
    this.param = param;
    this.code = code;
  }
}

export function splitModel(model: unknown): ModelIdentifier {
  const slashIndex = typeof model === "string" ? model.indexOf("/") : -1;
  if (typeof model !== "string" || !MODEL_NAME_PATTERN.test(model) || slashIndex < 1) {
    throw new ApiError(HTTP_BAD_REQUEST_STATUS, "model must use the provider/model format", "invalid_request_error", "model");
  }
  return { providerID: model.slice(0, slashIndex), modelID: model.slice(slashIndex + 1) };
}

export function normalizeResponsesRequest(body: unknown, lockedModel: string): NormalizedRequest {
  const requestBody = requestObject(body);
  rejectUnsupportedOptions(requestBody, false);
  requireLockedModel(requestBody["model"], lockedModel);

  const tools = normalizeTools(requestBody["tools"], false);
  const toolChoice = normalizeToolChoice(requestBody["tool_choice"], tools, false);
  const transcript: TranscriptEntry[] = [];
  const instructions = requestBody["instructions"];
  if (instructions != null && typeof instructions !== "string") {
    throw invalidRequest("instructions must be text", "instructions");
  }
  if (instructions) transcript.push({ role: "developer", content: instructions });

  const input = requestBody["input"];
  if (typeof input === "string") {
    transcript.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    transcript.push(...normalizeResponsesInput(input));
  } else {
    throw invalidRequest("input must be text or an array", "input");
  }

  return { kind: "responses", stream: normalizeStream(requestBody["stream"]), transcript, tools, toolChoice };
}

export function normalizeChatCompletionsRequest(body: unknown, lockedModel: string): NormalizedRequest {
  const requestBody = requestObject(body);
  rejectUnsupportedOptions(requestBody, true);
  requireLockedModel(requestBody["model"], lockedModel);

  const messages = requestBody["messages"];
  if (!Array.isArray(messages) || messages.length === 0) {
    throw invalidRequest("messages must be a non-empty array", "messages");
  }
  const tools = normalizeTools(requestBody["tools"], true);
  const toolChoice = normalizeToolChoice(requestBody["tool_choice"], tools, true);
  const transcript = messages.map(normalizeChatMessage);
  return { kind: "chat", stream: normalizeStream(requestBody["stream"]), transcript, tools, toolChoice };
}

export function createOpenCodeRequest(
  request: NormalizedRequest,
  model: string,
  variant: string | null | undefined,
  disabledToolIds: readonly string[],
): OpenCodeRequestBody {
  const allowedToolNames = new Set(request.toolChoice.names);
  const tools = request.tools.filter((tool) => allowedToolNames.has(tool.name));
  const toolDescriptions = tools.map(({ name, description }) => ({ name, description }));
  const prompt = [
    "You are an API model. Answer only from the supplied conversation.",
    "The calling client owns all function execution. Never claim that you ran a function.",
    request.toolChoice.mode === "none" ? "Return text." : "Choose text or one function call as allowed by the output schema.",
    "Conversation JSON:",
    JSON.stringify(request.transcript),
    tools.length > 0 ? `Available function descriptions:\n${JSON.stringify(toolDescriptions)}` : "",
  ].filter(Boolean).join("\n\n");
  const disabledTools = Object.fromEntries(disabledToolIds.map((toolId) => [toolId, false] as const));

  const body: OpenCodeRequestBody = {
    model: splitModel(model),
    agent: "opencode-as-openai-api",
    parts: [{ type: "text", text: prompt }],
    tools: disabledTools,
  };
  if (variant) body.variant = variant;
  if (tools.length > 0) {
    body.format = { type: "json_schema", schema: createResultSchema(tools, request.toolChoice.mode), retryCount: 2 };
  }
  return body;
}

export function createResultSchema(tools: readonly NormalizedTool[], mode: ToolChoiceMode): ResultSchema {
  const choices: UnknownRecord[] = tools.map((tool) => ({
    type: "object",
    additionalProperties: false,
    required: ["type", "name", "arguments"],
    properties: {
      type: { const: "function_call" },
      name: { const: tool.name },
      arguments: tool.parameters,
    },
  }));
  if (mode !== "required") {
    choices.unshift({
      type: "object",
      additionalProperties: false,
      required: ["type", "text"],
      properties: { type: { const: "text" }, text: { type: "string" } },
    });
  }
  return { type: "object", oneOf: choices };
}

export function parseOpenCodeResult(value: unknown, structuredOutput: StructuredOutputPolicy | null): OpenCodeResult {
  const response = upstreamResponseObject(value);
  const info = responseInfo(response);
  const text = responseText(response);
  const usage = usageOf(info);
  if (!structuredOutput) return { type: "text", text, usage };

  let output = info["structured"] ?? info["output"];
  if (output == null && text) {
    try {
      output = JSON.parse(text);
    } catch {
      throw invalidStructuredOutput();
    }
  }
  if (!isRecord(output)) throw invalidStructuredOutput();

  if (output["type"] === "text") {
    if (!structuredOutput.allowText || typeof output["text"] !== "string" || !hasOnlyKeys(output, TEXT_OUTPUT_KEYS)) {
      throw invalidStructuredOutput();
    }
    return { type: "text", text: output["text"], usage };
  }

  const functionName = output["name"];
  const functionArguments = output["arguments"];
  if (
    output["type"] !== "function_call"
    || typeof functionName !== "string"
    || !structuredOutput.allowedFunctionNames.includes(functionName)
    || !isRecord(functionArguments)
    || !hasOnlyKeys(output, FUNCTION_CALL_OUTPUT_KEYS)
  ) {
    throw invalidStructuredOutput();
  }

  return {
    type: "function_call",
    name: functionName,
    arguments: stringifyStructuredArguments(functionArguments),
    callId: `call_${randomUUID().replaceAll("-", "")}`,
    usage,
  };
}

export function createResponsesApiObject(
  result: OpenCodeResult,
  model: string,
  id = `resp_${randomUUID().replaceAll("-", "")}`,
  createdSeconds = Math.floor(Date.now() / MILLISECONDS_PER_SECOND),
): ResponsesApiObject {
  const output: [ResponseOutputItem] = result.type === "function_call"
    ? [{
      type: "function_call",
      id: `fc_${randomUUID().replaceAll("-", "")}`,
      call_id: result.callId,
      name: result.name,
      arguments: result.arguments,
      status: "completed",
    }]
    : [{
      type: "message",
      id: `msg_${randomUUID().replaceAll("-", "")}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: result.text, annotations: [] }],
    }];
  return {
    id,
    object: "response",
    created_at: createdSeconds,
    status: "completed",
    completed_at: Math.floor(Date.now() / MILLISECONDS_PER_SECOND),
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output,
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: {
      input_tokens: result.usage.input,
      output_tokens: result.usage.output,
      output_tokens_details: { reasoning_tokens: result.usage.reasoning },
      total_tokens: result.usage.total,
    },
    user: null,
    metadata: {},
  };
}

export function createChatCompletionObject(
  result: OpenCodeResult,
  model: string,
  id = `chatcmpl-${randomUUID().replaceAll("-", "")}`,
  createdSeconds = Math.floor(Date.now() / MILLISECONDS_PER_SECOND),
): ChatCompletionObject {
  const message: ChatMessage = result.type === "function_call"
    ? {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: result.callId,
        type: "function",
        function: { name: result.name, arguments: result.arguments },
      }],
    }
    : { role: "assistant", content: result.text, refusal: null };
  return {
    id,
    object: "chat.completion",
    created: createdSeconds,
    model,
    choices: [{
      index: 0,
      message,
      logprobs: null,
      finish_reason: result.type === "function_call" ? "tool_calls" : "stop",
    }],
    usage: {
      prompt_tokens: result.usage.input,
      completion_tokens: result.usage.output,
      total_tokens: result.usage.total,
      completion_tokens_details: { reasoning_tokens: result.usage.reasoning },
    },
  };
}

function requestObject(value: unknown): UnknownRecord {
  if (!isRecord(value)) throw invalidRequest("request body must be a JSON object", null, "invalid_json");
  return value;
}

function normalizeResponsesInput(input: unknown[]): TranscriptEntry[] {
  return input.map((item, index) => {
    const parameter = `input.${index}`;
    if (!isRecord(item)) throw invalidRequest("unsupported input type: unknown", parameter);
    const itemType = item["type"];
    const role = item["role"];

    if (itemType === "message" || role !== undefined) {
      if (typeof role !== "string" || !MESSAGE_ROLES.has(role)) {
        throw invalidRequest(`unsupported role: ${displayValue(role)}`, `${parameter}.role`);
      }
      return { role, content: textContent(item["content"], `${parameter}.content`) };
    }
    if (itemType === "function_call") {
      return {
        role: "assistant",
        function_call: {
          call_id: requiredString(item["call_id"], `${parameter}.call_id`),
          name: requiredString(item["name"], `${parameter}.name`),
          arguments: stringValue(item["arguments"], `${parameter}.arguments`),
        },
      };
    }
    if (itemType === "function_call_output") {
      return {
        role: "tool",
        call_id: requiredString(item["call_id"], `${parameter}.call_id`),
        content: textContent(item["output"], `${parameter}.output`),
      };
    }
    throw invalidRequest(`unsupported input type: ${displayValue(itemType)}`, parameter);
  });
}

function normalizeChatMessage(message: unknown, index: number): TranscriptEntry {
  const parameter = `messages.${index}`;
  if (!isRecord(message)) throw invalidRequest("message must be an object", parameter);
  const role = message["role"];
  if (typeof role !== "string" || !CHAT_MESSAGE_ROLES.has(role)) {
    throw invalidRequest(`unsupported role: ${displayValue(role)}`, `${parameter}.role`);
  }

  const entry: TranscriptEntry = {
    role,
    content: textContent(message["content"], `${parameter}.content`),
  };
  const toolCalls = message["tool_calls"];
  if (role === "assistant" && toolCalls != null) {
    entry.tool_calls = normalizeChatToolCalls(toolCalls, parameter);
  }
  if (role === "tool") {
    entry.tool_call_id = requiredString(message["tool_call_id"], `${parameter}.tool_call_id`);
  }
  return entry;
}

function normalizeChatToolCalls(value: unknown, messageParameter: string): ChatToolCall[] {
  if (!Array.isArray(value)) throw invalidRequest("tool_calls must be an array", `${messageParameter}.tool_calls`);
  return value.map((toolCall, index) => {
    const parameter = `${messageParameter}.tool_calls.${index}`;
    if (!isRecord(toolCall) || toolCall["type"] !== "function" || !isRecord(toolCall["function"])) {
      throw invalidRequest("only function tool calls are supported", parameter);
    }
    const functionCall = toolCall["function"];
    return {
      id: requiredString(toolCall["id"], `${parameter}.id`),
      type: "function",
      function: {
        name: requiredString(functionCall["name"], `${parameter}.function.name`),
        arguments: stringValue(functionCall["arguments"], `${parameter}.function.arguments`),
      },
    };
  });
}

function textContent(content: unknown, parameter: string): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw invalidRequest("message content must be text", parameter);
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (isRecord(part) && typeof part["type"] === "string" && TEXT_CONTENT_TYPES.has(part["type"]) && typeof part["text"] === "string") {
      return part["text"];
    }
    const contentType = isRecord(part) ? part["type"] : undefined;
    throw invalidRequest(`unsupported content type: ${displayValue(contentType)}`, parameter);
  }).join("");
}

function normalizeTools(value: unknown, chat: boolean): NormalizedTool[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw invalidRequest("tools must be an array", "tools");
  const tools = value.map((tool, index) => {
    const parameter = `tools.${index}`;
    if (!isRecord(tool) || tool["type"] !== "function") {
      throw invalidRequest("only function tools are supported", parameter);
    }
    const functionDefinition = chat ? tool["function"] : tool;
    if (!isRecord(functionDefinition) || typeof functionDefinition["name"] !== "string") {
      throw invalidRequest("only function tools are supported", parameter);
    }
    const functionName = functionDefinition["name"];
    if (!FUNCTION_NAME_PATTERN.test(functionName)) {
      throw invalidRequest("function name must use 1-64 letters, numbers, underscores, or hyphens", `${parameter}.name`);
    }
    const description = functionDefinition["description"];
    if (description !== undefined && typeof description !== "string") {
      throw invalidRequest("function description must be text", `${parameter}.description`);
    }
    const parameters = functionDefinition["parameters"];
    if (
      parameters != null
      && (!isRecord(parameters) || (parameters["type"] !== undefined && parameters["type"] !== "object"))
    ) {
      throw invalidRequest("function parameters must be an object", `${parameter}.parameters`);
    }
    return {
      name: functionName,
      description: description ?? "",
      parameters: parameters ?? { type: "object", properties: {}, additionalProperties: false },
    };
  });
  const functionNames = new Set<string>();
  for (const [index, tool] of tools.entries()) {
    if (functionNames.has(tool.name)) {
      throw invalidRequest(`duplicate function name: ${tool.name}`, `tools.${index}.name`);
    }
    functionNames.add(tool.name);
  }
  return tools;
}

function normalizeStream(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  throw invalidRequest("stream must be a boolean", "stream");
}

function normalizeToolChoice(
  value: unknown,
  tools: readonly NormalizedTool[],
  chat: boolean,
): NormalizedRequest["toolChoice"] {
  const allToolNames = tools.map((tool) => tool.name);
  if (value == null || value === "auto") return { mode: "auto", names: allToolNames };
  if (value === "none") return { mode: "none", names: [] };
  if (value === "required") {
    if (tools.length === 0) {
      throw invalidRequest("tool_choice requires at least one function tool", "tool_choice");
    }
    return { mode: "required", names: allToolNames };
  }

  if (!isRecord(value) || value["type"] !== "function") {
    throw invalidRequest("unsupported tool_choice", "tool_choice");
  }
  const functionChoice = value["function"];
  const functionName = chat && isRecord(functionChoice) ? functionChoice["name"] : value["name"];
  if (typeof functionName === "string" && allToolNames.includes(functionName)) {
    return { mode: "required", names: [functionName] };
  }
  throw invalidRequest("unsupported tool_choice", "tool_choice");
}

function rejectUnsupportedOptions(body: UnknownRecord, chat: boolean): void {
  if (chat) {
    if (body["n"] != null && body["n"] !== 1) rejectOption("n");
    if (body["logprobs"]) rejectOption("logprobs");
    if (body["response_format"]) rejectOption("response_format");
    return;
  }

  if (body["previous_response_id"]) rejectOption("previous_response_id");
  if (body["conversation"]) rejectOption("conversation");
  if (body["background"]) rejectOption("background");
  if (body["store"] === true) {
    throw invalidRequest("stored responses are not supported", "store");
  }
  const textOptions = body["text"];
  if (textOptions == null) return;
  if (!isRecord(textOptions)) rejectOption("text");
  const format = textOptions["format"];
  if (format != null && (!isRecord(format) || format["type"] !== "text")) rejectOption("text");
}

function rejectOption(field: string): never {
  throw invalidRequest(`${field} is not supported`, field);
}

function requireLockedModel(value: unknown, lockedModel: string): void {
  if (value === lockedModel) return;
  throw new ApiError(
    HTTP_NOT_FOUND_STATUS,
    `The model '${displayValue(value)}' does not exist`,
    "invalid_request_error",
    "model",
    "model_not_found",
  );
}

function requiredString(value: unknown, parameter: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw invalidRequest(`${parameter} must be a non-empty string`, parameter);
}

function stringValue(value: unknown, parameter: string): string {
  if (typeof value === "string") return value;
  throw invalidRequest(`${parameter} must be a string`, parameter);
}

function upstreamResponseObject(value: unknown): UnknownRecord {
  if (isRecord(value)) return value;
  throw invalidUpstream("OpenCode returned an invalid response");
}

function responseInfo(response: UnknownRecord): UnknownRecord {
  if (response["info"] != null) {
    if (isRecord(response["info"])) return response["info"];
    throw invalidUpstream("OpenCode returned invalid response info");
  }
  const data = response["data"];
  if (!isRecord(data)) return response;
  if (data["info"] != null) {
    if (isRecord(data["info"])) return data["info"];
    throw invalidUpstream("OpenCode returned invalid response info");
  }
  return data;
}

function responseText(response: UnknownRecord): string {
  const data = response["data"];
  const parts = response["parts"] ?? (isRecord(data) ? data["parts"] : undefined) ?? [];
  if (!Array.isArray(parts)) throw invalidUpstream("OpenCode returned invalid message parts");
  return parts.map((part) => {
    if (!isRecord(part) || part["type"] !== "text") return "";
    if (typeof part["text"] !== "string") throw invalidUpstream("OpenCode returned invalid text content");
    return part["text"];
  }).join("");
}

function usageOf(info: UnknownRecord): TokenUsage {
  const tokensValue = info["tokens"];
  if (tokensValue == null) return { input: 0, output: 0, reasoning: 0, total: 0 };
  if (!isRecord(tokensValue)) throw invalidUpstream("OpenCode returned invalid token usage");

  const input = tokenCount(tokensValue["input"]);
  const reasoning = tokenCount(tokensValue["reasoning"]);
  const generatedOutput = tokenCount(tokensValue["output"]);
  const output = addTokenCounts(generatedOutput, reasoning);
  const total = addTokenCounts(input, output);
  return { input, output, reasoning, total };
}

function tokenCount(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw invalidUpstream("OpenCode returned invalid token usage");
}

function addTokenCounts(firstCount: number, secondCount: number): number {
  const total = firstCount + secondCount;
  if (Number.isSafeInteger(total)) return total;
  throw invalidUpstream("OpenCode returned invalid token usage");
}

function stringifyStructuredArguments(value: UnknownRecord): string {
  try {
    return JSON.stringify(value);
  } catch {
    throw invalidStructuredOutput();
  }
}

function hasOnlyKeys(value: UnknownRecord, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function invalidStructuredOutput(): ApiError {
  return invalidUpstream("OpenCode returned invalid structured output");
}

function invalidUpstream(message: string): ApiError {
  return new ApiError(HTTP_BAD_GATEWAY_STATUS, message, "server_error", null, "upstream_error");
}

function invalidRequest(message: string, parameter: string | null, code: string | null = null): ApiError {
  return new ApiError(HTTP_BAD_REQUEST_STATUS, message, "invalid_request_error", parameter, code);
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "unknown";
  return String(value);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
