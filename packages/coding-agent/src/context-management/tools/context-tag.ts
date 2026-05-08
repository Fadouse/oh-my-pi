import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ToolDefinition } from "../../extensibility/extensions";
import type { SessionEntry, SessionManager } from "../../session/session-manager";
import { ToolError } from "../../tools/tool-errors";
import { findTagInTree, isAssistantInternalToolOnly, isInternalTool, resolveTargetId } from "../helpers";

export const contextTagSchema = Type.Object({
	name: Type.String({ description: "The tag/milestone name. Use meaningful names." }),
	target: Type.Optional(Type.String({ description: "The commit ID to tag. Defaults to HEAD (current state)." })),
});

export interface ContextTagDetails {
	id?: string;
	name?: string;
	error?: string;
}

export function createContextTagTool(_api: ExtensionAPI): ToolDefinition<typeof contextTagSchema, ContextTagDetails> {
	return {
		name: "context_tag",
		label: "Context Tag",
		description:
			"Creates a save point (bookmark) in the history. Use this before risky changes or when a feature is stable. Untagged progress is risky.",
		parameters: contextTagSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sm = ctx.sessionManager as SessionManager;
			const existingTagId = findTagInTree(sm, params.name);
			if (existingTagId) {
				const text = `Error: Tag '${params.name}' already exists at ${existingTagId}. Tag names must be unique. Use a different name or delete the existing tag first.`;
				return { content: [{ type: "text", text }], details: { error: text } };
			}

			const id = params.target ? resolveTargetId(sm, params.target) : resolveDefaultTagTarget(sm);
			if (!sm.getEntry(id)) {
				throw new ToolError(`context_tag target not found: ${params.target ?? "HEAD"} (resolved to ${id})`);
			}
			sm.appendLabelChange(id, params.name);
			return {
				content: [{ type: "text", text: `Created tag '${params.name}' at ${id}` }],
				details: { id, name: params.name },
			};
		},
	};
}

export function resolveDefaultTagTarget(sm: SessionManager): string {
	const branch = sm.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (shouldSkipAutoTagEntry(entry)) continue;
		return entry.id;
	}
	return sm.getLeafId() ?? "";
}

function shouldSkipAutoTagEntry(entry: SessionEntry): boolean {
	if (entry.type !== "message") return false;
	if (entry.message.role === "toolResult" && isInternalTool(entry.message.toolName)) return true;
	return isAssistantInternalToolOnly(entry);
}
