import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import {
	createKiroToolNames,
	ensureRootObjectSchema,
	KIRO_IMAGE_BASE64_BUDGET,
	KIRO_MAX_IMAGES_PER_MESSAGE,
	KIRO_MAX_IMAGES_PER_REQUEST,
	KIRO_MAX_TOOL_CATALOG_BYTES,
	KIRO_MAX_TOOL_COUNT,
	KIRO_MAX_TOOL_DESCRIPTION_CHARS,
	sanitizeKiroSchema,
	transformKiroRequest,
} from "@oh-my-pi/pi-ai/providers/kiro/index";
import type { AssistantMessage, Context, Message, Model, Tool, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const parameters = type({ path: "string" });
const zeroUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createModel(id = "gpt-5.6-luna"): Model<"kiro-api"> {
	return buildModel({
		id,
		name: id,
		api: "kiro-api",
		provider: "kiro",
		baseUrl: "https://runtime.us-east-1.kiro.dev/",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 4_096,
	});
}

function tool(name: string, description = "A tool."): Tool<typeof parameters> {
	return { name, description, parameters };
}

function assistant(content: AssistantMessage["content"], model = "gpt-5.6-luna"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "kiro-api",
		provider: "kiro",
		model,
		usage: zeroUsage,
		stopReason: "stop",
		timestamp: 1,
	};
}

function user(text: string): Message {
	return { role: "user", content: text, timestamp: 0 };
}

function imageMessage(count: number, data = "aGVsbG8="): Message {
	return {
		role: "user",
		content: Array.from({ length: count }, () => ({ type: "image" as const, data, mimeType: "image/png" })),
		timestamp: 0,
	};
}

function currentTools(context: Context) {
	return (
		transformKiroRequest(createModel(), context).conversationState.currentMessage.userInputMessage
			.userInputMessageContext?.tools ?? []
	);
}

describe("Kiro tool names", () => {
	test("keeps a valid name and aliases names the wire would reject", () => {
		const names = createKiroToolNames();
		expect(names.alias("read")).toBe("read");
		const spaced = names.alias("mcp__apps__workspace agents_create");
		expect(spaced).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
		const long = names.alias("x".repeat(90));
		expect(long).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
		expect(names.restore(spaced)).toBe("mcp__apps__workspace agents_create");
		expect(names.restore(long)).toBe("x".repeat(90));
		expect(names.restore("read")).toBe("read");
	});

	test("gives one name one alias, and two names two aliases", () => {
		const names = createKiroToolNames();
		const first = names.alias("a b");
		expect(names.alias("a b")).toBe(first);
		expect(names.alias("a_b")).toBe("a_b");
		expect(names.alias("a b")).not.toBe(names.alias("a_b"));
	});

	test("uses the same alias for the offered tool and its replayed call", () => {
		const name = "mcp__apps__workspace agents_create";
		const context: Context = {
			messages: [
				user("Start"),
				assistant([{ type: "toolCall", id: "call-1", name, arguments: { path: "a" } }]),
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: name,
					content: [{ type: "text", text: "done" }],
					isError: false,
					timestamp: 2,
				},
				user("Next"),
			],
			tools: [tool(name)],
		};
		const request = transformKiroRequest(createModel(), context);
		const offered = request.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools ?? [];
		const replayed = request.conversationState.history?.find(entry => entry.assistantResponseMessage)
			?.assistantResponseMessage?.toolUses?.[0]?.name;
		expect(offered).toHaveLength(1);
		expect(replayed).toBe(offered[0]?.toolSpecification.name);
	});
});

describe("Kiro tool schemas", () => {
	test("strips rejected keywords at any depth and keeps properties that share their names", () => {
		const sanitized = sanitizeKiroSchema({
			type: "object",
			additionalProperties: false,
			required: [],
			properties: {
				format: { type: "string", pattern: "^x$", minLength: 1 },
				nested: { type: "array", maxItems: 3, items: { type: "string", format: "uri" } },
			},
		});
		expect(sanitized).toEqual({
			type: "object",
			properties: {
				format: { type: "string" },
				nested: { type: "array", items: { type: "string" } },
			},
		});
	});

	test("flattens root composition into an object, keeping only allOf's required fields", () => {
		const flattened = ensureRootObjectSchema({
			description: "Pick one",
			properties: { path: { type: "string" } },
			required: ["path"],
			allOf: [{ properties: { mode: { type: "string" } }, required: ["mode"] }],
			oneOf: [{ properties: { a: { type: "string" } }, required: ["a"] }, { properties: { b: { type: "number" } } }],
		});
		expect(flattened).toEqual({
			description: "Pick one",
			type: "object",
			properties: {
				path: { type: "string" },
				mode: { type: "string" },
				a: { type: "string" },
				b: { type: "number" },
			},
			required: ["path", "mode"],
		});
	});

	test("adds a missing root object type and leaves nested composition alone", () => {
		const nested = { anyOf: [{ type: "string" }, { type: "number" }] };
		expect(ensureRootObjectSchema({ properties: { value: nested } })).toEqual({
			type: "object",
			properties: { value: nested },
		});
	});
});

describe("Kiro tool budget", () => {
	test("sends every tool when under budget, with no notice", () => {
		const context: Context = { messages: [user("Go")], systemPrompt: ["System."], tools: [tool("a"), tool("b")] };
		const request = transformKiroRequest(createModel(), context);
		expect(request.conversationState.currentMessage.userInputMessage.content).not.toContain("tool catalog limit");
		expect(currentTools(context)).toHaveLength(2);
	});

	test("caps the tool count and tells the model what is unavailable", () => {
		const tools = Array.from({ length: KIRO_MAX_TOOL_COUNT + 3 }, (_, index) => tool(`tool_${index}`));
		const context: Context = { messages: [user("Go")], tools };
		const request = transformKiroRequest(createModel(), context);
		const current = request.conversationState.currentMessage.userInputMessage;
		expect(current.userInputMessageContext?.tools).toHaveLength(KIRO_MAX_TOOL_COUNT);
		expect(current.content).toContain(`allows ${KIRO_MAX_TOOL_COUNT} of ${KIRO_MAX_TOOL_COUNT + 3} tools`);
		expect(current.content).toContain("tool_48, tool_49, tool_50");
		expect(current.content).toContain("Go");
	});

	test("skips a tool that does not fit the bytes and still admits smaller ones after it", () => {
		const filler = "d".repeat(9_000);
		const large = Array.from({ length: 12 }, (_, index) => tool(`large_${index}`, filler));
		const specs = currentTools({ messages: [user("Go")], tools: [...large, tool("small")] });
		const names = specs.map(spec => spec.toolSpecification.name);
		expect(names).toContain("small");
		expect(names.length).toBeLessThan(13);
		expect(new TextEncoder().encode(JSON.stringify(specs)).byteLength).toBeLessThanOrEqual(
			KIRO_MAX_TOOL_CATALOG_BYTES,
		);
	});

	test("cuts an oversized description without leaving half a surrogate pair", () => {
		const description = `${"d".repeat(KIRO_MAX_TOOL_DESCRIPTION_CHARS - 2)}😀${"d".repeat(50)}`;
		const sent = currentTools({ messages: [user("Go")], tools: [tool("big", description)] })[0]?.toolSpecification
			.description;
		expect(sent?.length).toBeLessThanOrEqual(KIRO_MAX_TOOL_DESCRIPTION_CHARS);
		expect(sent).toEndWith("…");
		expect(sent?.isWellFormed()).toBe(true);
	});

	test("offers no tools when tool choice is none", () => {
		const context: Context = { messages: [user("Go")], tools: [tool("a")] };
		const current = transformKiroRequest(createModel(), context, { toolChoice: "none" }).conversationState
			.currentMessage.userInputMessage;
		expect(current.userInputMessageContext?.tools).toBeUndefined();
	});
});

describe("Kiro reasoning replay", () => {
	const blob = ".KTR~~opaque.not-base64";
	const replayed = (message: AssistantMessage, model = createModel()) =>
		transformKiroRequest(model, { messages: [user("Start"), message, user("Next")] }).conversationState.history?.find(
			entry => entry.assistantResponseMessage,
		)?.assistantResponseMessage?.reasoningContent;

	test("replays a signature on the signature field", () => {
		const message = assistant([
			{ type: "text", text: "Answer" },
			{ type: "thinking", thinking: "...", thinkingSignature: blob },
		]);
		expect(replayed(message)).toEqual({ signature: blob });
	});

	test("replays redacted reasoning on its own field", () => {
		const message = assistant([
			{ type: "text", text: "Answer" },
			{ type: "redactedThinking", data: "aGVsbG8=" },
		]);
		expect(replayed(message)).toEqual({ redactedContent: "aGVsbG8=" });
	});

	test("does not replay a blob another model wrote", () => {
		const message = assistant(
			[
				{ type: "text", text: "Answer" },
				{ type: "thinking", thinking: "...", thinkingSignature: blob },
			],
			"claude-sonnet-5.5",
		);
		expect(replayed(message)).toBeUndefined();
	});

	test("sends nothing for a turn with no reasoning", () => {
		expect(replayed(assistant([{ type: "text", text: "Answer" }]))).toBeUndefined();
	});
});

describe("Kiro images", () => {
	const allImages = (context: Context) => {
		const state = transformKiroRequest(createModel(), context).conversationState;
		return [
			...(state.history ?? []).map(entry => entry.userInputMessage),
			state.currentMessage.userInputMessage,
		].flatMap(message => message?.images ?? []);
	};

	test("keeps an image in history after the turn that sent it", () => {
		const context: Context = {
			messages: [imageMessage(1), assistant([{ type: "text", text: "Seen" }]), user("Next")],
		};
		expect(allImages(context)).toHaveLength(1);
	});

	test("caps one message at the per-message limit, keeping the newest, and says so", () => {
		const message = imageMessage(KIRO_MAX_IMAGES_PER_MESSAGE + 2);
		const current = transformKiroRequest(createModel(), { messages: [message] }).conversationState.currentMessage
			.userInputMessage;
		expect(current.images).toHaveLength(KIRO_MAX_IMAGES_PER_MESSAGE);
		expect(current.content).toContain("per-message limit");
	});

	test("drops the oldest images past the request limit and leaves the current turn whole", () => {
		const messages: Message[] = [];
		for (let index = 0; index < 6; index++) {
			messages.push(imageMessage(KIRO_MAX_IMAGES_PER_MESSAGE), assistant([{ type: "text", text: "Seen" }]));
		}
		messages.push(imageMessage(KIRO_MAX_IMAGES_PER_MESSAGE));
		const state = transformKiroRequest(createModel(), { messages }).conversationState;
		expect(allImages({ messages })).toHaveLength(KIRO_MAX_IMAGES_PER_REQUEST);
		expect(state.currentMessage.userInputMessage.images).toHaveLength(KIRO_MAX_IMAGES_PER_MESSAGE);
		expect(state.history?.[0]?.userInputMessage?.images).toBeUndefined();
		expect(state.history?.[0]?.userInputMessage?.content).toContain("request limit");
	});

	test("drops the oldest images past the byte budget", () => {
		const large = "a".repeat(Math.floor(KIRO_IMAGE_BASE64_BUDGET / 2) + 1024);
		const messages: Message[] = [
			imageMessage(1, large),
			assistant([{ type: "text", text: "Seen" }]),
			imageMessage(1, large),
			assistant([{ type: "text", text: "Seen" }]),
			imageMessage(1, large),
		];
		const model = buildModel({ ...createModel(), contextWindow: 1_000_000 });
		const state = transformKiroRequest(model, { messages }).conversationState;
		expect(state.history?.[0]?.userInputMessage?.images).toBeUndefined();
		expect(state.history?.[0]?.userInputMessage?.content).toContain("image size limit");
		expect(state.currentMessage.userInputMessage.images).toHaveLength(1);
	});

	test("does not count image bytes as conversation size", () => {
		const large = "a".repeat(2_000_000);
		const messages: Message[] = [imageMessage(1, large), assistant([{ type: "text", text: "Seen" }]), user("Next")];
		expect(() => transformKiroRequest(createModel(), { messages })).not.toThrow();
	});

	test("leaves out an unsupported image in history instead of failing the session", () => {
		const messages: Message[] = [
			{ role: "user", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/tiff" }], timestamp: 0 },
			assistant([{ type: "text", text: "Seen" }]),
			user("Next"),
		];
		expect(allImages({ messages })).toHaveLength(0);
	});
});

describe("Kiro empty tool results", () => {
	test("fills an empty result so the wire never sees blank text", () => {
		const context: Context = {
			messages: [
				user("Go"),
				assistant([{ type: "toolCall", id: "call-1", name: "lookup", arguments: { path: "a" } }]),
				{ role: "toolResult", toolCallId: "call-1", toolName: "lookup", content: [], isError: false, timestamp: 2 },
			],
		};
		const current = transformKiroRequest(createModel(), context).conversationState.currentMessage.userInputMessage;
		expect(current.userInputMessageContext?.toolResults?.[0]?.content).toEqual([
			{ text: "The tool completed without textual output." },
		]);
		expect(current.content).toBe("The requested tool result is attached.");
	});
});
