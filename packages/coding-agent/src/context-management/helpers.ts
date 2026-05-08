import type { ImageContent, TextContent, ToolCall } from "@oh-my-pi/pi-ai";
import type { ReadonlySessionManager, SessionEntry, SessionTreeNode } from "../session/session-manager";

const INTERNAL_TOOLS = new Set(["context_tag", "context_log", "context_checkout", "context_status"]);

export const isInternalTool = (name: string): boolean => INTERNAL_TOOLS.has(name);

export function resolveTargetId(sm: ReadonlySessionManager, target: string): string {
	if (target.toLowerCase() === "root") {
		const tree = sm.getTree();
		return tree.length > 0 ? tree[0].entry.id : target;
	}

	if (/^[0-9a-f]{8,}$/i.test(target)) return target;

	const stack: SessionTreeNode[] = [...sm.getTree()];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (sm.getLabel(node.entry.id) === target) return node.entry.id;
		for (let i = node.children.length - 1; i >= 0; i--) {
			stack.push(node.children[i]);
		}
	}

	return target;
}

export function findTagInTree(sm: ReadonlySessionManager, tagName: string): string | undefined {
	const stack: SessionTreeNode[] = [...sm.getTree()];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (sm.getLabel(node.entry.id) === tagName) return node.entry.id;
		for (let i = node.children.length - 1; i >= 0; i--) {
			stack.push(node.children[i]);
		}
	}
	return undefined;
}

export function getMessagePreview(entry: SessionEntry, _sm: ReadonlySessionManager, verbose: boolean): string {
	if (entry.type === "branch_summary" || entry.type === "compaction") {
		return entry.summary || "[No summary provided]";
	}
	if (entry.type === "label") return `tag: ${entry.label ?? ""}`;
	if (entry.type === "custom_message") return textFromContent(entry.content);
	if (entry.type === "session_init") return entry.task;
	if (entry.type === "model_change") return `model: ${entry.model}${entry.role ? ` (${entry.role})` : ""}`;
	if (entry.type === "thinking_level_change") return `thinking: ${entry.thinkingLevel ?? "off"}`;
	if (entry.type === "service_tier_change") return `service tier: ${entry.serviceTier ?? "default"}`;
	if (entry.type === "mode_change") return `mode: ${entry.mode}`;
	if (entry.type === "ttsr_injection") return `ttsr: ${entry.injectedRules.join(", ")}`;
	if (entry.type === "mcp_tool_selection") return `mcp tools: ${entry.selectedToolNames.join(", ")}`;
	if (entry.type === "custom") return `custom: ${entry.customType}`;

	const msg = entry.message;
	if (msg.role === "toolResult") {
		if (!verbose && isInternalTool(msg.toolName)) return "";
		let resultText = textFromContent(msg.content);
		const details = msg.details;
		if (
			(msg.toolName === "read" || msg.toolName === "edit") &&
			details &&
			typeof details === "object" &&
			"path" in details &&
			typeof details.path === "string"
		) {
			resultText = `${details.path}: ${resultText}`;
		}
		return `(${msg.toolName}) ${resultText}`.trim();
	}
	if (msg.role === "bashExecution") return `[Bash] ${msg.command}`;
	if (msg.role === "pythonExecution") return `[Python] ${msg.code}`;
	if (msg.role === "fileMention") return msg.files.map(file => file.path).join(", ");
	if (msg.role === "branchSummary" || msg.role === "compactionSummary") return msg.summary;
	if (msg.role === "custom" || msg.role === "hookMessage") return textFromContent(msg.content);

	if (msg.role === "user") return textFromContent(msg.content);
	if (msg.role === "assistant") {
		const text = textFromContent(msg.content);
		const toolCallsText = msg.content
			.filter(isToolCall)
			.filter(toolCall => verbose || !isInternalTool(toolCall.name))
			.map(toolCall => `call: ${toolCall.name}(${JSON.stringify(toolCall.arguments)})`)
			.join("; ");
		return [text, toolCallsText].filter(Boolean).join(" ");
	}

	return "";
}

export function entryRole(entry: SessionEntry): string {
	if (entry.type === "message") {
		const role = entry.message.role;
		if (role === "assistant") return "AI";
		if (role === "user") return "USER";
		if (role === "bashExecution") return "BASH";
		if (role === "pythonExecution") return "PYTHON";
		if (role === "toolResult") return "TOOL";
		return role.toUpperCase();
	}
	if (entry.type === "branch_summary" || entry.type === "compaction") return "SUMMARY";
	return entry.type.toUpperCase();
}

export function isAssistantInternalToolOnly(entry: SessionEntry): boolean {
	if (entry.type !== "message" || entry.message.role !== "assistant") return false;
	const content = entry.message.content;
	const toolCalls = content.filter(isToolCall);
	if (toolCalls.length === 0) return false;
	const hasText = content.some(block => block.type === "text" && block.text.trim().length > 0);
	return !hasText && toolCalls.every(toolCall => isInternalTool(toolCall.name));
}

export function recentToolResultDensity(branch: SessionEntry[], windowSize: number): number {
	const recent = branch.slice(-Math.max(0, windowSize));
	if (recent.length === 0) return 0;
	const toolResults = recent.filter(entry => entry.type === "message" && entry.message.role === "toolResult");
	return toolResults.length / recent.length;
}

export function consecutiveTrailingErrors(branch: SessionEntry[]): number {
	let count = 0;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		if (entry.message.role !== "toolResult") break;
		if (!entry.message.isError) break;
		count++;
	}
	return count;
}

export function turnsSinceUserMilestone(branch: SessionEntry[]): number {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "user") return branch.length - 1 - i;
	}
	return branch.length;
}
export function normalizePreview(text: string, maxLength = 100): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function textFromContent(content: string | (TextContent | ImageContent | ToolCall | { type: string })[]): string {
	if (typeof content === "string") return content;
	return content
		.map(part => {
			if ("text" in part && typeof part.text === "string") return part.text;
			return "";
		})
		.join(" ")
		.trim();
}

function isToolCall(block: TextContent | ImageContent | ToolCall | { type: string }): block is ToolCall {
	return block.type === "toolCall" && "name" in block && typeof block.name === "string";
}
