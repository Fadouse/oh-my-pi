import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "./session-manager";

const CONTEXT_REF_TAG_NAME = "ctx";
const CONTEXT_REF_REGEX = /^m(\d{4})$/;
const CONTEXT_REF_WIDTH = 4;
const FIRST_CONTEXT_REF_INDEX = 1;
const LAST_CONTEXT_REF_INDEX = 9999;

const messageEntryIds = new WeakMap<object, string>();

export function rememberContextEntryMessage(message: AgentMessage, entryId: string): void {
	messageEntryIds.set(message, entryId);
}

export function getContextEntryIdForMessage(message: AgentMessage): string | undefined {
	return messageEntryIds.get(message);
}

export function isContextRef(value: string): boolean {
	return parseContextRef(value) !== undefined;
}

export function parseContextRef(value: string): number | undefined {
	const match = value.trim().toLowerCase().match(CONTEXT_REF_REGEX);
	if (!match) return undefined;
	const index = Number.parseInt(match[1], 10);
	if (!Number.isInteger(index) || index < FIRST_CONTEXT_REF_INDEX || index > LAST_CONTEXT_REF_INDEX) {
		return undefined;
	}
	return index;
}

export function formatContextRef(index: number): string {
	if (!Number.isInteger(index) || index < FIRST_CONTEXT_REF_INDEX || index > LAST_CONTEXT_REF_INDEX) {
		throw new Error(`Context ref index out of bounds: ${index}`);
	}
	return `m${index.toString().padStart(CONTEXT_REF_WIDTH, "0")}`;
}

export function buildContextRefMaps(entries: SessionEntry[]): {
	byRef: Map<string, string>;
	byEntryId: Map<string, string>;
} {
	const byRef = new Map<string, string>();
	const byEntryId = new Map<string, string>();
	let index = FIRST_CONTEXT_REF_INDEX;

	for (const entry of entries) {
		if (!isContextReferenceableEntry(entry)) continue;
		const ref = formatContextRef(index);
		byRef.set(ref, entry.id);
		byEntryId.set(entry.id, ref);
		index++;
	}

	return { byRef, byEntryId };
}

export function resolveContextRef(entries: SessionEntry[], ref: string): string | undefined {
	const normalized = ref.trim().toLowerCase();
	if (!isContextRef(normalized)) return undefined;
	return buildContextRefMaps(entries).byRef.get(normalized);
}

export function injectContextRefsIntoMessages(
	llmMessages: Message[],
	agentMessages: AgentMessage[],
	entries: SessionEntry[],
): Message[] {
	const refsByEntryId = buildContextRefMaps(entries).byEntryId;
	let llmIndex = 0;
	let changed = false;
	const nextMessages = [...llmMessages];

	for (const agentMessage of agentMessages) {
		if (!agentMessageConvertsToLlm(agentMessage)) continue;

		const llmMessage = nextMessages[llmIndex];
		llmIndex++;
		if (!llmMessage) break;

		const entryId = getContextEntryIdForMessage(agentMessage);
		if (!entryId) continue;

		const ref = refsByEntryId.get(entryId);
		if (!ref) continue;

		nextMessages[llmIndex - 1] = appendContextRef(llmMessage, ref);
		changed = true;
	}

	return changed ? nextMessages : llmMessages;
}

function isContextReferenceableEntry(entry: SessionEntry): boolean {
	return (
		entry.type === "message" ||
		entry.type === "custom_message" ||
		entry.type === "branch_summary" ||
		entry.type === "compaction"
	);
}

function agentMessageConvertsToLlm(message: AgentMessage): boolean {
	if (message.role === "bashExecution" || message.role === "pythonExecution") {
		return message.excludeFromContext !== true;
	}
	return (
		message.role === "custom" ||
		message.role === "hookMessage" ||
		message.role === "branchSummary" ||
		message.role === "compactionSummary" ||
		message.role === "fileMention" ||
		message.role === "user" ||
		message.role === "developer" ||
		message.role === "assistant" ||
		message.role === "toolResult"
	);
}

function appendContextRef(message: Message, ref: string): Message {
	const tag = `\n\n<${CONTEXT_REF_TAG_NAME}>${ref}</${CONTEXT_REF_TAG_NAME}>`;

	if (message.role === "user" || message.role === "developer") {
		return {
			...message,
			content: appendTagToStringOrTextContent(message.content, tag),
		};
	}

	if (message.role === "assistant") {
		const content = appendTagToExistingTextContent(message.content, tag);
		if (!content) return message;
		return {
			...message,
			content,
		};
	}

	return {
		...message,
		content: appendTagToTextContent(message.content, tag),
	};
}

function appendTagToStringOrTextContent(
	content: string | (TextContent | ImageContent)[],
	tag: string,
): string | (TextContent | ImageContent)[] {
	if (typeof content === "string") return `${content}${tag}`;
	return appendTagToTextContent(content, tag);
}

function appendTagToTextContent<T extends { type: string }>(
	content: readonly T[],
	tag: string,
): Array<T | TextContent> {
	return appendTagToExistingTextContent(content, tag) ?? [...content, { type: "text", text: tag }];
}

function appendTagToExistingTextContent<T extends { type: string }>(
	content: readonly T[],
	tag: string,
): Array<T | TextContent> | undefined {
	const next: Array<T | TextContent> = [...content];
	for (let index = next.length - 1; index >= 0; index--) {
		const item = next[index];
		if (!item || !isTextContent(item)) continue;
		next[index] = { ...item, text: `${item.text}${tag}` };
		return next;
	}
	return undefined;
}

function isTextContent(content: { type: string }): content is TextContent {
	return content.type === "text";
}
