import type { SimpleStreamOptions } from "../../types";

export interface KiroStreamCredential {
	token: string;
	profileArn?: string;
	apiEndpoint?: string;
}

export interface KiroOptions extends SimpleStreamOptions {
	/** Resolved bearer or the internal JSON projection produced by Kiro OAuth. */
	apiKey?: string;
}

export interface KiroToolUse {
	name: string;
	toolUseId: string;
	input: Record<string, unknown>;
}

export interface KiroToolResult {
	content: Array<{ text: string }>;
	status: "success" | "error";
	toolUseId: string;
}

export interface KiroToolSpec {
	toolSpecification: {
		name: string;
		description: string;
		inputSchema: { json: Record<string, unknown> };
	};
}

export interface KiroImageBlock {
	format: "jpeg" | "png" | "gif" | "webp";
	source: { bytes: string };
}

export interface KiroUserInputMessage {
	content: string;
	modelId: string;
	origin: "KIRO_CLI";
	images?: KiroImageBlock[];
	userInputMessageContext?: {
		toolResults?: KiroToolResult[];
		tools?: KiroToolSpec[];
	};
}

/** Exactly one member is set: the wire validates each member's shape. */
export type KiroReasoningContent = { signature: string } | { redactedContent: string };

export interface KiroAssistantResponseMessage {
	content: string;
	toolUses?: KiroToolUse[];
	reasoningContent?: KiroReasoningContent;
}

export interface KiroHistoryEntry {
	userInputMessage?: KiroUserInputMessage;
	assistantResponseMessage?: KiroAssistantResponseMessage;
}

export type KiroAnthropicRequestFields = {
	thinking: { type: "adaptive"; display: "summarized" | "omitted" };
	output_config: { effort: string };
	max_tokens?: number;
};

export type KiroGptRequestFields = {
	reasoning: { effort: string };
};

export type KiroModelRequestFields = KiroAnthropicRequestFields | KiroGptRequestFields;

export interface KiroRequest {
	agentMode: "vibe";
	conversationState: {
		chatTriggerType: "MANUAL";
		agentTaskType: "vibe";
		conversationId: string;
		currentMessage: { userInputMessage: KiroUserInputMessage };
		history?: KiroHistoryEntry[];
	};
	profileArn?: string;
	additionalModelRequestFields?: KiroModelRequestFields;
}

export interface KiroUsageMetrics {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	reasoningTokens?: number;
}

/** Why a safety filter stopped the response. Upstream text, so it is bounded on the way in. */
export interface KiroRefusalDetails {
	category?: string;
	explanation?: string;
}

export type KiroNormalizedEvent =
	| { type: "metadata"; requestId?: string; stopReason?: string; refusal?: KiroRefusalDetails }
	| { type: "reasoning"; text?: string; signature?: string; redactedContent?: string }
	| { type: "content"; content: string; stopReason?: string }
	| {
			type: "tool";
			toolUseId: string;
			name?: string;
			input?: string | Record<string, unknown>;
			stop?: boolean;
	  }
	| { type: "contextUsage"; percentage: number }
	| { type: "usage"; usage: KiroUsageMetrics }
	| { type: "ignored" };
