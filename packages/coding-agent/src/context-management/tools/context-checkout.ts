import { logger } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ToolDefinition } from "../../extensibility/extensions";
import type { SessionManager } from "../../session/session-manager";
import { resolveTargetId } from "../helpers";
import { setPending } from "../state";

export const contextCheckoutSchema = Type.Object({
	target: Type.String({
		description:
			"Where to jump/squash to. Can be a tag name (e.g., 'task-start'), a commit ID, or 'root'. This is the base for your new branch.",
	}),
	message: Type.String({
		description:
			"Carryover message for the new branch. Summarize current progress/lessons to bring with you: status, reason, important changes, and next step.",
	}),
	backupTag: Type.Optional(
		Type.String({
			description:
				"Optional tag name to apply to the current state before checking out. Use this to create an automatic backup of the history you are about to leave/squash.",
		}),
	),
});

export interface ContextCheckoutDetails {
	targetId?: string;
	summaryEntryId?: string;
	backupTagApplied?: string;
}

export function createContextCheckoutTool(
	api: ExtensionAPI,
): ToolDefinition<typeof contextCheckoutSchema, ContextCheckoutDetails> {
	return {
		name: "context_checkout",
		label: "Context Checkout",
		description:
			"Navigate to any point in conversation history. This only resets conversation history, not disk files. Always provide a detailed message to bridge context.",
		parameters: contextCheckoutSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sm = ctx.sessionManager as SessionManager;
			const targetId = resolveTargetId(sm, params.target);
			const currentLeaf = sm.getLeafId();
			if (currentLeaf === targetId) {
				return { content: [{ type: "text", text: `Already at target ${targetId}` }], details: { targetId } };
			}

			let backupTagApplied: string | undefined;
			if (params.backupTag && currentLeaf) {
				api.setLabel(currentLeaf, params.backupTag);
				backupTagApplied = params.backupTag;
			}

			const targetLabel = sm.getLabel(targetId);
			const origin = targetLabel ? `tag: ${targetLabel}` : shortId(targetId);
			const enrichedMessage = `(summary from ${origin})\n${params.message}`;
			const summaryEntryId = sm.branchWithSummary(
				targetId,
				enrichedMessage,
				{ source: "context_checkout", backupTag: params.backupTag, target: params.target },
				true,
			);

			const sid = sm.getSessionId();
			const previous = setPending(sid, {
				targetId,
				summaryEntryId,
				enrichedMessage,
				backupTagApplied,
				origin,
				rawTarget: params.target,
			});
			if (previous) {
				logger.warn("context-management: overwrote pending checkout", {
					sid,
					previousSummaryEntryId: previous.summaryEntryId,
					summaryEntryId,
				});
			}

			return {
				content: [
					{
						type: "text",
						text: `Checkout staged. Aborting current turn; will rebase on tag ${params.target}.`,
					},
				],
				details: { targetId, summaryEntryId, backupTagApplied },
			};
		},
	};
}

function shortId(id: string): string {
	return id.length > 12 ? id.slice(0, 12) : id;
}
