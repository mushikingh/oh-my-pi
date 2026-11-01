import { describe, expect, test } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { crc32 } from "@oh-my-pi/pi-ai/providers/aws-eventstream";
import { kiroAlternateRuntimeUrl, kiroHttpError, streamKiro } from "@oh-my-pi/pi-ai/providers/kiro/index";
import type { AssistantMessage, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const CONTEXT: Context = { messages: [{ role: "user", content: "Say hello", timestamp: 0 }] };
const EVENTSTREAM_HEADERS = { "content-type": "application/vnd.amazon.eventstream" };
const API_KEY = JSON.stringify({ token: "test-token" });

function createModel(baseUrl = "https://runtime.us-east-1.kiro.dev/"): Model<"kiro-api"> {
	return buildModel({
		id: "gpt-5.6-luna",
		name: "gpt-5.6-luna",
		api: "kiro-api",
		provider: "kiro",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 2_048,
	});
}

function header(name: string, value: string): Uint8Array {
	const nameBytes = new TextEncoder().encode(name);
	const valueBytes = new TextEncoder().encode(value);
	const output = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	const view = new DataView(output.buffer);
	view.setUint8(0, nameBytes.length);
	output.set(nameBytes, 1);
	view.setUint8(1 + nameBytes.length, 7);
	view.setUint16(2 + nameBytes.length, valueBytes.length, false);
	output.set(valueBytes, 4 + nameBytes.length);
	return output;
}

function frame(eventType: string, payload: unknown, messageType = "event"): Uint8Array {
	const typeHeader = messageType === "event" ? ":event-type" : ":exception-type";
	const headers = Buffer.concat([header(":message-type", messageType), header(typeHeader, eventType)]);
	const body = new TextEncoder().encode(JSON.stringify(payload));
	const total = 12 + headers.length + body.length + 4;
	const output = new Uint8Array(total);
	const view = new DataView(output.buffer);
	view.setUint32(0, total, false);
	view.setUint32(4, headers.length, false);
	view.setUint32(8, crc32(output.subarray(0, 8)), false);
	output.set(headers, 12);
	output.set(body, 12 + headers.length);
	view.setUint32(total - 4, crc32(output.subarray(0, total - 4)), false);
	return output;
}

function eventResponse(...frames: Uint8Array[]): Response {
	return new Response(Buffer.concat(frames), { status: 200, headers: EVENTSTREAM_HEADERS });
}

function okResponse(): Response {
	return eventResponse(frame("assistantResponseEvent", { content: "hello" }));
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function run(fetchImpl: FetchImpl, model = createModel()): Promise<AssistantMessage> {
	return streamKiro(model, CONTEXT, { apiKey: API_KEY, fetch: fetchImpl }).result();
}

/** Serves the responses in order and records each URL it was asked for. */
function scripted(...responses: (Response | Error)[]): { fetch: FetchImpl; urls: string[] } {
	const urls: string[] = [];
	const fetchImpl = (async (input: Parameters<FetchImpl>[0]) => {
		urls.push(String(input));
		const next = responses.shift();
		if (!next) throw new Error("unexpected extra request");
		if (next instanceof Error) throw next;
		return next;
	}) as FetchImpl;
	return { fetch: fetchImpl, urls };
}

describe("Kiro rejection classification", () => {
	for (const [status, reason] of [
		[429, "MONTHLY_REQUEST_COUNT"],
		[400, "MONTHLY_REQUEST_COUNT"],
		[429, "OVERAGE_REQUEST_LIMIT_EXCEEDED"],
	] as const) {
		test(`${status} ${reason} is a usage limit, not a retryable throttle`, async () => {
			const error = await kiroHttpError(jsonResponse(status, { reason, message: "Limit reached" }));
			expect(AIError.isUsageLimit(error)).toBe(true);
			expect(AIError.isProviderRetryableError(error)).toBe(false);
		});
	}

	test("a suspension is an account policy denial", async () => {
		const byReason = await kiroHttpError(jsonResponse(403, { reason: "TEMPORARILY_SUSPENDED", message: "Nope" }));
		const byWords = await kiroHttpError(jsonResponse(403, { message: "We have locked your account." }));
		expect(AIError.isAccountPolicyError(byReason)).toBe(true);
		expect(AIError.isAccountPolicyError(byWords)).toBe(true);
	});

	test("a request over the content limit is a context overflow", async () => {
		const error = await kiroHttpError(
			jsonResponse(400, { reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD", message: "Input is too long." }),
		);
		expect(AIError.is(AIError.classify(error), AIError.Flag.ContextOverflow)).toBe(true);
	});

	test("an ordinary rejection keeps no verdict", async () => {
		const error = await kiroHttpError(jsonResponse(400, { reason: "OTHER", message: "Bad field" }));
		expect(AIError.isUsageLimit(error)).toBe(false);
		expect(AIError.isAccountPolicyError(error)).toBe(false);
		const denied = await kiroHttpError(jsonResponse(403, { message: "Access denied" }));
		expect(AIError.isAccountPolicyError(denied)).toBe(false);
	});

	test("a quota reason without a matching status is not a usage limit", async () => {
		const error = await kiroHttpError(jsonResponse(500, { reason: "MONTHLY_REQUEST_COUNT", message: "Odd" }));
		expect(AIError.is(AIError.classify(error), AIError.Flag.UsageLimit)).toBe(false);
	});

	test("a missing profile says how to fix it", async () => {
		const error = await kiroHttpError(jsonResponse(400, { message: "profileArn is required for this model" }));
		expect(error.message).toContain("/login kiro");
	});

	test("a quota failure inside the event stream is a usage limit too", async () => {
		const { fetch } = scripted(
			eventResponse(
				frame("ThrottlingException", { reason: "MONTHLY_REQUEST_COUNT", message: "Limit reached" }, "exception"),
			),
		);
		const result = await run(fetch);
		expect(result.stopReason).toBe("error");
		expect(AIError.is(AIError.classifyMessage(result), AIError.Flag.UsageLimit)).toBe(true);
	});
});

describe("Kiro content filter stops", () => {
	test("end the turn as a blocked refusal, with Kiro's reason", async () => {
		const { fetch, urls } = scripted(
			eventResponse(
				frame("assistantResponseEvent", { content: "partial" }),
				frame("metadataEvent", {
					stopReason: "CONTENT_FILTERED",
					stopDetails: { refusal: { category: "cyber", explanation: "Not allowed." } },
				}),
			),
		);
		const result = await run(fetch);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("CONTENT_FILTERED, category cyber");
		expect(result.errorMessage).toContain("Not allowed.");
		expect(AIError.is(AIError.classifyMessage(result), AIError.Flag.ContentBlocked)).toBe(true);
		expect(urls).toHaveLength(1);
	});

	test("survive a refusal payload of an unexpected shape", async () => {
		const { fetch } = scripted(
			eventResponse(
				frame("assistantResponseEvent", { content: "partial" }),
				frame("metadataEvent", { stopReason: "GUARDRAIL_INTERVENED", stopDetails: { refusal: "nope" } }),
			),
		);
		const result = await run(fetch);
		expect(AIError.is(AIError.classifyMessage(result), AIError.Flag.ContentBlocked)).toBe(true);
	});
});

describe("Kiro reasoning capture", () => {
	test("keeps a signature that arrives after its block closed", async () => {
		const { fetch } = scripted(
			eventResponse(
				frame("reasoningContentEvent", { text: "..." }),
				frame("assistantResponseEvent", { content: "hello" }),
				frame("reasoningContentEvent", { signature: ".KTR~~blob" }),
			),
		);
		const result = await run(fetch);
		const thinking = result.content.find(part => part.type === "thinking");
		expect(thinking?.type === "thinking" ? thinking.thinkingSignature : undefined).toBe(".KTR~~blob");
	});

	test("keeps a signature that arrives with no reasoning text at all", async () => {
		const { fetch } = scripted(
			eventResponse(
				frame("assistantResponseEvent", { content: "hello" }),
				frame("reasoningContentEvent", { signature: ".KTR~~blob" }),
			),
		);
		const result = await run(fetch);
		const thinking = result.content.find(part => part.type === "thinking");
		expect(thinking?.type === "thinking" ? thinking.thinkingSignature : undefined).toBe(".KTR~~blob");
		expect(result.stopReason).toBe("stop");
	});

	test("records redacted reasoning for replay", async () => {
		const { fetch } = scripted(
			eventResponse(
				frame("assistantResponseEvent", { content: "hello" }),
				frame("reasoningContentEvent", { redactedContent: "aGVsbG8=" }),
			),
		);
		const result = await run(fetch);
		expect(result.content).toContainEqual({ type: "redactedThinking", data: "aGVsbG8=" });
	});
});

describe("Kiro alternate runtime host", () => {
	test("maps only canonical runtime hosts", () => {
		expect(kiroAlternateRuntimeUrl("https://runtime.eu-central-1.kiro.dev/")).toBe(
			"https://q.eu-central-1.amazonaws.com/",
		);
		expect(kiroAlternateRuntimeUrl("https://runtime.us-east-1.kiro.dev.evil.example/")).toBeUndefined();
		expect(kiroAlternateRuntimeUrl("https://q.us-east-1.amazonaws.com/")).toBeUndefined();
		expect(kiroAlternateRuntimeUrl("not a url")).toBeUndefined();
	});

	for (const status of [502, 503, 504]) {
		test(`moves to the alternate host after a ${status}`, async () => {
			const { fetch, urls } = scripted(new Response("bad gateway", { status }), okResponse());
			const result = await run(fetch);
			expect(result.stopReason).toBe("stop");
			expect(urls).toEqual(["https://runtime.us-east-1.kiro.dev/", "https://q.us-east-1.amazonaws.com/"]);
		});
	}

	test("moves to the alternate host after a connection failure", async () => {
		const refused = Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
		const { fetch, urls } = scripted(refused, okResponse());
		const result = await run(fetch);
		expect(result.stopReason).toBe("stop");
		expect(urls[1]).toBe("https://q.us-east-1.amazonaws.com/");
	});

	test("tries the alternate host only once", async () => {
		const { fetch, urls } = scripted(new Response("x", { status: 503 }), new Response("x", { status: 503 }));
		const result = await run(fetch);
		expect(result.stopReason).toBe("error");
		expect(urls).toHaveLength(2);
	});

	test("does not move on a request error", async () => {
		const { fetch, urls } = scripted(jsonResponse(400, { reason: "OTHER", message: "Bad field" }));
		await run(fetch);
		expect(urls).toHaveLength(1);
	});
});
