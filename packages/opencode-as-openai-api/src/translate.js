import { randomUUID } from "node:crypto";

export class ApiError extends Error {
  constructor(status, message, type = "invalid_request_error", param = null, code = null) {
    super(message);
    this.status = status;
    this.type = type;
    this.param = param;
    this.code = code;
  }
}

export function splitModel(model) {
  const slash = typeof model === "string" ? model.indexOf("/") : -1;
  if (slash < 1 || slash === model.length - 1) {
    throw new ApiError(400, "model must use the provider/model format", "invalid_request_error", "model");
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

function textContent(content, param) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new ApiError(400, "message content must be text", "invalid_request_error", param);
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (["input_text", "output_text", "text"].includes(part?.type) && typeof part.text === "string") return part.text;
    throw new ApiError(400, `unsupported content type: ${part?.type ?? "unknown"}`, "invalid_request_error", param);
  }).join("");
}

function normalizeTools(tools, chat) {
  if (tools == null) return [];
  if (!Array.isArray(tools)) throw new ApiError(400, "tools must be an array", "invalid_request_error", "tools");
  return tools.map((tool, index) => {
    const fn = chat ? tool?.function : tool;
    if (tool?.type !== "function" || !fn || typeof fn.name !== "string") {
      throw new ApiError(400, "only function tools are supported", "invalid_request_error", `tools.${index}`);
    }
    return {
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: fn.parameters && typeof fn.parameters === "object"
        ? fn.parameters
        : { type: "object", properties: {}, additionalProperties: false },
    };
  });
}

function normalizeToolChoice(value, tools, chat) {
  if (value == null || value === "auto") return { mode: "auto", names: tools.map((tool) => tool.name) };
  if (value === "none") return { mode: "none", names: [] };
  if (value === "required") {
    if (tools.length === 0) throw new ApiError(400, "tool_choice requires at least one function tool", "invalid_request_error", "tool_choice");
    return { mode: "required", names: tools.map((tool) => tool.name) };
  }
  const name = chat ? value?.function?.name : value?.name;
  if ((value?.type === "function") && typeof name === "string" && tools.some((tool) => tool.name === name)) {
    return { mode: "required", names: [name] };
  }
  throw new ApiError(400, "unsupported tool_choice", "invalid_request_error", "tool_choice");
}

function rejectCommon(body, chat) {
  const unsupported = chat
    ? [["n", (value) => value != null && value !== 1], ["logprobs", Boolean], ["response_format", Boolean]]
    : [["previous_response_id", Boolean], ["conversation", Boolean], ["background", Boolean], ["text", (value) => value?.format?.type && value.format.type !== "text"]];
  for (const [field, rejects] of unsupported) {
    if (rejects(body[field])) throw new ApiError(400, `${field} is not supported`, "invalid_request_error", field);
  }
  if (!chat && body.store === true) throw new ApiError(400, "stored responses are not supported", "invalid_request_error", "store");
}

export function normalizeResponses(body, lockedModel) {
  rejectCommon(body, false);
  if (body.model !== lockedModel) throw new ApiError(404, `The model '${body.model}' does not exist`, "invalid_request_error", "model", "model_not_found");
  const tools = normalizeTools(body.tools, false);
  const toolChoice = normalizeToolChoice(body.tool_choice, tools, false);
  const transcript = [];
  if (typeof body.instructions === "string" && body.instructions) transcript.push({ role: "developer", content: body.instructions });
  if (typeof body.input === "string") transcript.push({ role: "user", content: body.input });
  else if (Array.isArray(body.input)) {
    for (const [index, item] of body.input.entries()) {
      if (item?.type === "message" || item?.role) {
        if (!["system", "developer", "user", "assistant"].includes(item.role)) {
          throw new ApiError(400, `unsupported role: ${item.role ?? "unknown"}`, "invalid_request_error", `input.${index}.role`);
        }
        transcript.push({ role: item.role, content: textContent(item.content, `input.${index}.content`) });
      } else if (item?.type === "function_call") {
        transcript.push({ role: "assistant", function_call: { call_id: item.call_id, name: item.name, arguments: item.arguments } });
      } else if (item?.type === "function_call_output") {
        transcript.push({ role: "tool", call_id: item.call_id, content: textContent(item.output, `input.${index}.output`) });
      } else {
        throw new ApiError(400, `unsupported input type: ${item?.type ?? "unknown"}`, "invalid_request_error", `input.${index}`);
      }
    }
  } else {
    throw new ApiError(400, "input must be text or an array", "invalid_request_error", "input");
  }
  return { kind: "responses", stream: body.stream === true, transcript, tools, toolChoice };
}

export function normalizeChat(body, lockedModel) {
  rejectCommon(body, true);
  if (body.model !== lockedModel) throw new ApiError(404, `The model '${body.model}' does not exist`, "invalid_request_error", "model", "model_not_found");
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ApiError(400, "messages must be a non-empty array", "invalid_request_error", "messages");
  }
  const tools = normalizeTools(body.tools, true);
  const toolChoice = normalizeToolChoice(body.tool_choice, tools, true);
  const transcript = [];
  for (const [index, message] of body.messages.entries()) {
    if (!["system", "developer", "user", "assistant", "tool"].includes(message?.role)) {
      throw new ApiError(400, `unsupported role: ${message?.role ?? "unknown"}`, "invalid_request_error", `messages.${index}.role`);
    }
    const entry = { role: message.role, content: textContent(message.content, `messages.${index}.content`) };
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) entry.tool_calls = message.tool_calls;
    if (message.role === "tool") entry.tool_call_id = message.tool_call_id;
    transcript.push(entry);
  }
  return { kind: "chat", stream: body.stream === true, transcript, tools, toolChoice };
}

export function openCodeRequest(request, model, variant, disabledTools) {
  const allowed = new Set(request.toolChoice.names);
  const tools = request.tools.filter((tool) => allowed.has(tool.name));
  const prompt = [
    "You are an API model. Answer only from the supplied conversation.",
    "The calling client owns all function execution. Never claim that you ran a function.",
    request.toolChoice.mode === "none" ? "Return text." : "Choose text or one function call as allowed by the output schema.",
    "Conversation JSON:",
    JSON.stringify(request.transcript),
    tools.length ? `Available function descriptions:\n${JSON.stringify(tools.map(({ name, description }) => ({ name, description })))}` : "",
  ].filter(Boolean).join("\n\n");
  const body = {
    model: splitModel(model),
    agent: "opencode-as-openai-api",
    parts: [{ type: "text", text: prompt }],
    tools: Object.fromEntries(disabledTools.map((id) => [id, false])),
  };
  if (variant) body.variant = variant;
  if (tools.length) body.format = { type: "json_schema", schema: resultSchema(tools, request.toolChoice.mode), retryCount: 2 };
  return body;
}

export function resultSchema(tools, mode) {
  const choices = tools.map((tool) => ({
    type: "object",
    additionalProperties: false,
    required: ["type", "name", "arguments"],
    properties: {
      type: { const: "function_call" },
      name: { const: tool.name },
      arguments: tool.parameters,
    },
  }));
  if (mode !== "required") choices.unshift({
    type: "object",
    additionalProperties: false,
    required: ["type", "text"],
    properties: { type: { const: "text" }, text: { type: "string" } },
  });
  return { type: "object", oneOf: choices };
}

function partsOf(value) {
  return value?.parts ?? value?.data?.parts ?? [];
}

function infoOf(value) {
  return value?.info ?? value?.data?.info ?? value?.data ?? value ?? {};
}

export function openCodeResult(value, usedStructuredOutput) {
  const info = infoOf(value);
  const text = partsOf(value).filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
  let output = info.structured ?? info.output;
  if (usedStructuredOutput && !output && text) {
    try { output = JSON.parse(text); } catch { /* handled below */ }
  }
  if (usedStructuredOutput) {
    if (output?.type === "function_call" && typeof output.name === "string" && output.arguments && typeof output.arguments === "object") {
      return { type: "function_call", name: output.name, arguments: JSON.stringify(output.arguments), callId: `call_${randomUUID().replaceAll("-", "")}` , usage: usageOf(info) };
    }
    if (output?.type === "text" && typeof output.text === "string") return { type: "text", text: output.text, usage: usageOf(info) };
    throw new ApiError(502, "OpenCode returned invalid structured output", "server_error", null, "upstream_error");
  }
  return { type: "text", text, usage: usageOf(info) };
}

function usageOf(info) {
  const tokens = info?.tokens ?? {};
  const input = Number(tokens.input ?? 0);
  const reasoning = Number(tokens.reasoning ?? 0);
  const output = Number(tokens.output ?? 0) + reasoning;
  return { input, output, reasoning, total: input + output };
}

export function responseObject(result, model, id = `resp_${randomUUID().replaceAll("-", "")}`, created = Math.floor(Date.now() / 1000)) {
  const output = result.type === "function_call"
    ? [{ type: "function_call", id: `fc_${randomUUID().replaceAll("-", "")}`, call_id: result.callId, name: result.name, arguments: result.arguments, status: "completed" }]
    : [{ type: "message", id: `msg_${randomUUID().replaceAll("-", "")}`, status: "completed", role: "assistant", content: [{ type: "output_text", text: result.text, annotations: [] }] }];
  return {
    id, object: "response", created_at: created, status: "completed", completed_at: Math.floor(Date.now() / 1000),
    error: null, incomplete_details: null, instructions: null, max_output_tokens: null, model, output,
    parallel_tool_calls: false, previous_response_id: null, reasoning: { effort: null, summary: null }, store: false,
    temperature: 1, text: { format: { type: "text" } }, tool_choice: "auto", tools: [], top_p: 1,
    truncation: "disabled", usage: { input_tokens: result.usage.input, output_tokens: result.usage.output, output_tokens_details: { reasoning_tokens: result.usage.reasoning }, total_tokens: result.usage.total },
    user: null, metadata: {},
  };
}

export function chatObject(result, model, id = `chatcmpl-${randomUUID().replaceAll("-", "")}`, created = Math.floor(Date.now() / 1000)) {
  const message = result.type === "function_call"
    ? { role: "assistant", content: null, tool_calls: [{ id: result.callId, type: "function", function: { name: result.name, arguments: result.arguments } }] }
    : { role: "assistant", content: result.text, refusal: null };
  return {
    id, object: "chat.completion", created, model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: result.type === "function_call" ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: result.usage.input, completion_tokens: result.usage.output, total_tokens: result.usage.total, completion_tokens_details: { reasoning_tokens: result.usage.reasoning } },
  };
}
