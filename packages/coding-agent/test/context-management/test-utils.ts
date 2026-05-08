import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

export function user(content: string, timestamp = Date.now()): UserMessage {
	return { role: "user", content, timestamp };
}

export function assistantText(content: string, timestamp = Date.now()): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: content }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

export function assistantToolOnly(name: string, timestamp = Date.now()): AssistantMessage {
	return {
		...assistantText("", timestamp),
		content: [{ type: "toolCall", id: `call-${name}`, name, arguments: {} }],
	};
}

export function toolResult(name: string, text: string, timestamp = Date.now()): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${name}`,
		toolName: name,
		content: [{ type: "text", text }],
		details: {},
		isError: false,
		timestamp,
	};
}

export function makeApi(session: SessionManager, sendMessages: unknown[] = []): ExtensionAPI {
	return {
		setLabel: (targetId: string, label?: string) => {
			session.appendLabelChange(targetId, label);
		},
		sendMessage: (message: unknown, options: unknown) => {
			sendMessages.push({ message, options });
		},
		on: () => {},
		registerTool: () => {},
	} as unknown as ExtensionAPI;
}

export function makeContext(session: SessionManager, overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	const ui = {
		notify: () => {},
	} as unknown as ExtensionUIContext;
	return {
		ui,
		getContextUsage: () => undefined,
		compact: async () => {},
		navigateTree: async () => ({ cancelled: false }),
		hasUI: false,
		cwd: process.cwd(),
		sessionManager: session,
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: undefined,
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getSystemPrompt: () => [],
		hasQueuedMessages: () => false,
		...overrides,
	};
}

export function textResultContent(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	const first = content[0];
	return first?.type === "text" ? first.text : "";
}
