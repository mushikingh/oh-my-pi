import type { KiroImageBlock, KiroRequest, KiroUserInputMessage } from "./types";

/**
 * The 100-image request cap comes from the runtime's IMAGE_COUNT_EXCEEDED error. The other two are
 * policy taken from adjacent AWS limits: Bedrock allows 20 images per message and 25,000,000 bytes
 * per request, so 18 MiB bounds the image share of the body with room for text and tools.
 */
export const KIRO_MAX_IMAGES_PER_MESSAGE = 20;
export const KIRO_MAX_IMAGES_PER_REQUEST = 100;
export const KIRO_IMAGE_BASE64_BUDGET = 18 * 1024 * 1024;

const MESSAGE_CAP_NOTE =
	"[images omitted: exceeded the 20-image per-message limit; the oldest in this message were dropped]";
const REQUEST_CAP_NOTE =
	"[images omitted: exceeded the 100-image request limit; the oldest in the conversation were dropped]";
const BYTE_BUDGET_NOTE =
	"[images omitted: exceeded the request's image size limit; the oldest in the conversation were dropped]";

function appendNote(message: KiroUserInputMessage, note: string): void {
	message.content = message.content ? `${message.content}\n${note}` : note;
}

function imageMessages(request: KiroRequest): KiroUserInputMessage[] {
	const state = request.conversationState;
	const messages: KiroUserInputMessage[] = [];
	for (const entry of state.history ?? []) if (entry.userInputMessage) messages.push(entry.userInputMessage);
	messages.push(state.currentMessage.userInputMessage);
	return messages;
}

/** Drop images the first predicate rejects from one message, leaving a note whenever one went. */
function keepImages(message: KiroUserInputMessage, keep: (image: KiroImageBlock) => boolean, note: string): void {
	if (!message.images) return;
	const kept = message.images.filter(keep);
	if (kept.length === message.images.length) return;
	if (kept.length > 0) message.images = kept;
	else delete message.images;
	appendNote(message, note);
}

/** Apply the image limits oldest-first, so the newest images survive. Mutates the request. */
export function limitKiroImages(request: KiroRequest): void {
	const messages = imageMessages(request);
	for (const message of messages) {
		const images = message.images;
		if (!images || images.length <= KIRO_MAX_IMAGES_PER_MESSAGE) continue;
		message.images = images.slice(images.length - KIRO_MAX_IMAGES_PER_MESSAGE);
		appendNote(message, MESSAGE_CAP_NOTE);
	}
	let excess = messages.reduce((sum, message) => sum + (message.images?.length ?? 0), 0) - KIRO_MAX_IMAGES_PER_REQUEST;
	for (const message of messages) {
		if (excess <= 0) break;
		keepImages(message, () => excess-- <= 0, REQUEST_CAP_NOTE);
	}
	let bytes = messages.reduce(
		(sum, message) => sum + (message.images ?? []).reduce((total, image) => total + image.source.bytes.length, 0),
		0,
	);
	for (const message of messages) {
		if (bytes <= KIRO_IMAGE_BASE64_BUDGET) break;
		keepImages(
			message,
			image => {
				if (bytes <= KIRO_IMAGE_BASE64_BUDGET) return true;
				bytes -= image.source.bytes.length;
				return false;
			},
			BYTE_BUDGET_NOTE,
		);
	}
}
