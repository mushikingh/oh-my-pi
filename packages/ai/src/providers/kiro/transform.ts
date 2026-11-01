import { prompt } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import type {
	Context,
	Effort,
	ImageContent,
	Message,
	Model,
	ToolCall,
	ToolChoice,
	ToolResultMessage,
} from "../../types";
import { buildKiroModelRequestFields } from "./adaptive-thinking";
import { type KiroAssistantGroup, type KiroOrdinaryMessage, prepareKiroHistory } from "./history";
import { createKiroToolUseIdNormalizer } from "./id-normalizer";
import { limitKiroImages } from "./images";
import continuationPrompt from "./prompts/continuation.md" with { type: "text" };
import historicalToolDescriptionPrompt from "./prompts/historical-tool-description.md" with { type: "text" };
import joinedContentPrompt from "./prompts/joined-content.md" with { type: "text" };
import { convertKiroTools, createKiroToolNames, type KiroToolNames } from "./tools";
import type {
	KiroAssistantResponseMessage,
	KiroHistoryEntry,
	KiroImageBlock,
	KiroReasoningContent,
	KiroRequest,
	KiroToolResult,
	KiroToolSpec,
	KiroUserInputMessage,
} from "./types";

const CONTINUATION_PROMPT = prompt.render(continuationPrompt);
const HISTORICAL_TOOL_DESCRIPTION = prompt.render(historicalToolDescriptionPrompt);
const IMAGE_PLACEHOLDER = "(see attached image)";
const EMPTY_TOOL_RESULT = "The tool completed without textual output.";
const HISTORY_BASE_BYTES = 850_000;
const HISTORY_BASE_TOKENS = 200_000;

function joinPromptContent(prefix: string, content: string): string {
	return prompt.render(joinedContentPrompt, { prefix, content });
}
function textContent(message: Message): string {
	if (typeof message.content === "string") return message.content.toWellFormed();
	let text = "";
	for (const part of message.content) if (part.type === "text") text += part.text;
	return text.toWellFormed();
}
function joinMessageText(messages: readonly KiroOrdinaryMessage[]): string {
	let text = "";
	for (const message of messages) {
		const next = textContent(message);
		if (next) text = text ? joinPromptContent(text, next) : next;
	}
	return text;
}
function imageFormat(mimeType: string): KiroImageBlock["format"] | undefined {
	switch (mimeType.trim().toLowerCase()) {
		case "image/jpeg":
		case "image/jpg":
			return "jpeg";
		case "image/png":
			return "png";
		case "image/gif":
			return "gif";
		case "image/webp":
			return "webp";
		default:
			return undefined;
	}
}
function isImageContent(part: unknown): part is ImageContent {
	return typeof part === "object" && part !== null && "type" in part && part.type === "image" && "mimeType" in part;
}
function imageContent(message: Message): KiroImageBlock[] {
	if (typeof message.content === "string") return [];
	const images: KiroImageBlock[] = [];
	for (const part of message.content) {
		if (!isImageContent(part)) continue;
		const format = imageFormat(part.mimeType);
		if (!format) throw new Error(`Kiro does not support image type: ${part.mimeType}`);
		images.push({ format, source: { bytes: part.data } });
	}
	return images;
}
/**
 * Images of a message already in history. One recorded under another provider may have a type Kiro
 * cannot take, and that must not fail every later turn of the session, so it is left out instead.
 */
function historicalImages(message: Message): KiroImageBlock[] {
	if (typeof message.content === "string") return [];
	const images: KiroImageBlock[] = [];
	for (const part of message.content) {
		if (!isImageContent(part)) continue;
		const format = imageFormat(part.mimeType);
		if (format) images.push({ format, source: { bytes: part.data } });
	}
	return images;
}
function parseToolArguments(call: ToolCall): Record<string, unknown> {
	if (typeof call.arguments !== "string") return call.arguments;
	const value: unknown = JSON.parse(call.arguments);
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`Kiro historical tool call ${call.id} must contain a JSON object`);
	return value as Record<string, unknown>;
}
/**
 * The reasoning blob to replay on an assistant turn. Dropping it makes the model restart its
 * reasoning every turn. The blob is only valid for the model that wrote it, so a turn from another
 * model replays nothing. Merged turns keep the newest, which covers the reasoning up to their end.
 *
 * The two fields cannot be swapped: the wire validates their shape, and GPT-5.6's `.KTR~~` signature
 * is not base64, so sending it as `redactedContent` is rejected as an improperly formed request.
 */
function reasoningContent(group: KiroAssistantGroup, model: Model): KiroReasoningContent | undefined {
	let latest: KiroReasoningContent | undefined;
	for (const message of group.messages) {
		if (message.api !== model.api || message.model !== model.id) continue;
		for (const part of message.content) {
			if (part.type === "thinking" && part.thinkingSignature) latest = { signature: part.thinkingSignature };
			else if (part.type === "redactedThinking") latest = { redactedContent: part.data };
		}
	}
	return latest;
}
function assistantMessage(
	group: KiroAssistantGroup,
	model: Model,
	normalizeId: (id: string) => string,
	names: KiroToolNames,
): KiroAssistantResponseMessage {
	let text = "";
	for (const message of group.messages) {
		for (const part of message.content) {
			if (part.type === "text") text += part.text;
		}
	}
	const toolUses = group.calls.map(call => ({
		name: names.alias(call.name),
		toolUseId: normalizeId(call.id),
		input: parseToolArguments(call),
	}));
	const reasoning = reasoningContent(group, model);
	return {
		content: text.toWellFormed(),
		...(toolUses.length > 0 ? { toolUses } : {}),
		...(reasoning ? { reasoningContent: reasoning } : {}),
	};
}
function hasImageContent(message: Message): boolean {
	return typeof message.content !== "string" && message.content.some(isImageContent);
}
function toolResult(message: ToolResultMessage, normalizeId: (id: string) => string): KiroToolResult {
	const text = textContent(message);
	return {
		content: [{ text: text || (hasImageContent(message) ? IMAGE_PLACEHOLDER : EMPTY_TOOL_RESULT) }],
		status: message.isError ? "error" : "success",
		toolUseId: normalizeId(message.toolCallId),
	};
}
function appendHistoricalToolPlaceholders(tools: KiroToolSpec[], history: readonly KiroHistoryEntry[]): void {
	const names = new Set(tools.map(tool => tool.toolSpecification.name));
	for (const entry of history)
		for (const use of entry.assistantResponseMessage?.toolUses ?? [])
			if (!names.has(use.name)) {
				names.add(use.name);
				tools.push({
					toolSpecification: {
						name: use.name,
						description: HISTORICAL_TOOL_DESCRIPTION,
						inputSchema: { json: { type: "object", properties: {} } },
					},
				});
			}
}
function userMessage(content: string, modelId: string): KiroUserInputMessage {
	return { content: content.toWellFormed(), modelId, origin: "KIRO_CLI" };
}
function ordinaryImages(messages: readonly KiroOrdinaryMessage[]): KiroImageBlock[] {
	return messages.flatMap(imageContent);
}
function historicalResultCarrier(
	group: KiroAssistantGroup,
	ordinary: readonly KiroOrdinaryMessage[],
	modelId: string,
	normalizeId: (id: string) => string,
	content: string,
): KiroUserInputMessage {
	const images = [...ordinary.flatMap(historicalImages), ...group.results.flatMap(historicalImages)];
	return {
		...userMessage(content, modelId),
		...(images.length > 0 ? { images } : {}),
		userInputMessageContext: { toolResults: group.results.map(result => toolResult(result, normalizeId)) },
	};
}
/** Conversation text only: images have their own budget and must not read as context overflow. */
function serializedHistoryBytes(history: readonly KiroHistoryEntry[]): number {
	const withoutImages = JSON.stringify(history, (key, value) => (key === "images" ? undefined : value));
	return new TextEncoder().encode(withoutImages).byteLength;
}
function validateWireHistory(history: readonly KiroHistoryEntry[]): void {
	let expected: "user" | "assistant" = "user";
	const calls = new Set<string>();
	for (const entry of history) {
		const isUser = entry.userInputMessage !== undefined;
		const isAssistant = entry.assistantResponseMessage !== undefined;
		if (isUser === isAssistant || (isUser && expected !== "user") || (isAssistant && expected !== "assistant"))
			throw new Error("Kiro history alternation is invalid");
		if (isAssistant) {
			for (const use of entry.assistantResponseMessage?.toolUses ?? []) {
				if (calls.has(use.toolUseId)) throw new Error(`Kiro history duplicate wire tool id: ${use.toolUseId}`);
				calls.add(use.toolUseId);
			}
			expected = "user";
		} else {
			for (const result of entry.userInputMessage?.userInputMessageContext?.toolResults ?? []) {
				if (!calls.has(result.toolUseId)) throw new Error(`Kiro history orphan tool result: ${result.toolUseId}`);
				calls.delete(result.toolUseId);
			}
			expected = "assistant";
		}
	}
	if (calls.size > 0) throw new Error("Kiro history contains an incomplete tool-call batch");
}

export function transformKiroRequest(
	model: Model,
	context: Context,
	options: {
		reasoning?: Effort;
		disableReasoning?: boolean;
		hideThinkingSummary?: boolean;
		maxTokens?: number;
		conversationId?: string;
		/** Pass one to read tool names back from the response. */
		toolNames?: KiroToolNames;
		toolChoice?: ToolChoice;
	} = {},
): KiroRequest {
	const normalizer = createKiroToolUseIdNormalizer();
	const names = options.toolNames ?? createKiroToolNames();
	// Offered tools claim their names before replayed calls, so an offered tool keeps its plain name.
	const catalog = convertKiroTools(options.toolChoice === "none" ? [] : (context.tools ?? []), names);
	const plan = prepareKiroHistory(context.messages);
	const modelId = model.requestModelId ?? model.id;
	const history: KiroHistoryEntry[] = [];
	let systemPending = [
		...(context.systemPrompt ?? []),
		...(catalog.omittedNotice ? [catalog.omittedNotice] : []),
	].join("\n");
	for (const segment of plan.history) {
		if (segment.kind === "assistant") {
			history.push({
				assistantResponseMessage: assistantMessage(segment.group, model, id => normalizer.normalize(id), names),
			});
			continue;
		}
		const ordinary = joinMessageText(segment.group.messages);
		if (segment.group.resultGroup) {
			history.push({
				userInputMessage: historicalResultCarrier(
					segment.group.resultGroup,
					segment.group.messages,
					modelId,
					id => normalizer.normalize(id),
					ordinary,
				),
			});
			continue;
		}
		const images = segment.group.messages.flatMap(historicalImages);
		let content = ordinary || (images.length > 0 ? IMAGE_PLACEHOLDER : "");
		if (systemPending) {
			content = joinPromptContent(systemPending, content);
			systemPending = "";
		}
		history.push({
			userInputMessage: { ...userMessage(content, modelId), ...(images.length > 0 ? { images } : {}) },
		});
	}
	let currentContent = CONTINUATION_PROMPT;
	let currentImages: KiroImageBlock[] = [];
	const currentContext: NonNullable<KiroUserInputMessage["userInputMessageContext"]> = {};
	if (plan.current.kind === "user") {
		const ordinary = joinMessageText(plan.current.group.messages);
		if (plan.current.group.resultGroup) {
			currentContent = ordinary;
			if (systemPending && ordinary) {
				currentContent = joinPromptContent(systemPending, ordinary);
				systemPending = "";
			}
			currentContext.toolResults = plan.current.group.resultGroup.results.map(result =>
				toolResult(result, id => normalizer.normalize(id)),
			);
			currentImages = [
				...ordinaryImages(plan.current.group.messages),
				...plan.current.group.resultGroup.results.flatMap(imageContent),
			];
		} else {
			currentContent = ordinary;
			if (systemPending) {
				currentContent = joinPromptContent(systemPending, currentContent);
				systemPending = "";
			}
			currentImages = ordinaryImages(plan.current.group.messages);
		}
	}
	// Tool results need no text beside them: a filler sentence reads as a message from the user.
	if (currentContent.trim().length === 0 && !currentContext.toolResults) currentContent = CONTINUATION_PROMPT;
	const toolSpecs: KiroToolSpec[] = catalog.tools;
	appendHistoricalToolPlaceholders(toolSpecs, history);
	if (toolSpecs.length > 0) currentContext.tools = toolSpecs;
	const requestFields = options.disableReasoning
		? undefined
		: buildKiroModelRequestFields(model, options.reasoning, options.hideThinkingSummary, options.maxTokens);
	const request: KiroRequest = {
		agentMode: "vibe",
		conversationState: {
			chatTriggerType: "MANUAL",
			agentTaskType: "vibe",
			conversationId: options.conversationId ?? crypto.randomUUID(),
			currentMessage: {
				userInputMessage: {
					...userMessage(currentContent, modelId),
					...(currentImages.length > 0 ? { images: currentImages } : {}),
					...(Object.keys(currentContext).length > 0 ? { userInputMessageContext: currentContext } : {}),
				},
			},
			...(history.length > 0 ? { history } : {}),
		},
		...(requestFields ? { additionalModelRequestFields: requestFields } : {}),
	};
	limitKiroImages(request);
	validateWireHistory([
		...(request.conversationState.history ?? []),
		{ userInputMessage: request.conversationState.currentMessage.userInputMessage },
	]);
	const contextWindow = model.contextWindow ?? HISTORY_BASE_TOKENS;
	const maxHistoryBytes = Math.floor(HISTORY_BASE_BYTES * (contextWindow / HISTORY_BASE_TOKENS));
	if (serializedHistoryBytes(request.conversationState.history ?? []) > maxHistoryBytes)
		throw AIError.attach(
			new Error(`Kiro history exceeds local limit of ${maxHistoryBytes} UTF-8 bytes`),
			AIError.create(AIError.Flag.ContextOverflow),
		);
	return request;
}
