import { logger } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import { Settings } from "../../config/settings";
import type { ExtensionAPI, ToolDefinition } from "../../extensibility/extensions";
import type { SessionManager } from "../../session/session-manager";
import { getLatestTodoPhasesFromEntries, type TodoPhase } from "../../tools/todo-write";
import { ToolError } from "../../tools/tool-errors";
import { resolveTargetId } from "../helpers";
import { parseCheckoutMessage, validateCheckoutSchema } from "../schema";
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
	mode: Type.Optional(
		Type.Union([Type.Literal("squash"), Type.Literal("jump"), Type.Literal("recover")], {
			description:
				"Checkout mode: squash (default) creates a summary, jump relaxes schema for exploratory moves, recover restores a known tag without writing a summary.",
		}),
	),
});

export interface ContextCheckoutDetails {
	targetId?: string;
	summaryEntryId?: string;
	backupTagApplied?: string;
	mode?: "squash" | "jump" | "recover";
	openTodos?: TodoPhase[];
}

export function createContextCheckoutTool(
	api: ExtensionAPI,
	configuredSettings?: Settings,
): ToolDefinition<typeof contextCheckoutSchema, ContextCheckoutDetails> {
	return {
		name: "context_checkout",
		label: "Context Checkout",
		description:
			"Navigate to any point in conversation history. This only resets conversation history, not disk files. Always provide a detailed message to bridge context.",
		parameters: contextCheckoutSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const runtimeSettings = configuredSettings ?? Settings.isolated({ "contextManagement.enabled": true });
			const sm = ctx.sessionManager as SessionManager;
			const targetId = resolveTargetId(sm, params.target);
			const currentLeaf = sm.getLeafId();
			if (currentLeaf === targetId) {
				return { content: [{ type: "text", text: `Already at target ${targetId}` }], details: { targetId } };
			}
			if (!sm.getEntry(targetId)) {
				throw new ToolError(`context_checkout target not found: ${params.target} (resolved to ${targetId})`);
			}

			const mode = params.mode ?? "squash";
			validateModeAndSchema({
				mode,
				message: params.message,
				strictSchema: runtimeSettings.get("contextManagement.checkout.strictSchema"),
			});

			if (mode === "recover") {
				const targetLabel = sm.getLabel(targetId);
				if (!targetLabel || targetLabel !== params.target) {
					throw new ToolError(`Recover mode requires a known tag target; got ${params.target}`);
				}
				const sid = sm.getSessionId();
				const previous = setPending(sid, {
					targetId,
					summaryEntryId: targetId,
					enrichedMessage: params.message,
					backupTagApplied: undefined,
					origin: `tag: ${targetLabel}`,
					rawTarget: params.target,
					mode,
					navigateTargetId: targetId,
				});
				if (previous) {
					logger.warn("context-management: overwrote pending checkout", {
						sid,
						previousSummaryEntryId: previous.summaryEntryId,
						summaryEntryId: targetId,
					});
				}
				return {
					content: [
						{
							type: "text",
							text: `Recover checkout staged. Aborting current turn; will restore tag ${params.target}.`,
						},
					],
					details: { targetId, summaryEntryId: targetId, mode },
				};
			}

			let backupTagApplied: string | undefined;
			if (params.backupTag && currentLeaf) {
				api.setLabel(currentLeaf, params.backupTag);
				backupTagApplied = params.backupTag;
			}

			const targetLabel = sm.getLabel(targetId);
			const origin = targetLabel ? `tag: ${targetLabel}` : shortId(targetId);
			const enrichedMessage = `(summary from ${origin})\n${params.message}`;
			const openTodos = runtimeSettings.get("contextManagement.todoCoupling")
				? getLatestTodoPhasesFromEntries(sm.getBranch())
				: [];
			const summaryDetails: {
				source: "context_checkout";
				backupTag: string | undefined;
				target: string;
				mode: "squash" | "jump" | "recover";
				openTodos?: TodoPhase[];
			} = { source: "context_checkout", backupTag: params.backupTag, target: params.target, mode };
			if (openTodos.length > 0) summaryDetails.openTodos = openTodos;
			const summaryEntryId = sm.branchWithSummary(targetId, enrichedMessage, summaryDetails, true);

			const sid = sm.getSessionId();
			const previous = setPending(sid, {
				targetId,
				summaryEntryId,
				enrichedMessage,
				backupTagApplied,
				origin,
				rawTarget: params.target,
				mode,
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
				details: {
					targetId,
					summaryEntryId,
					backupTagApplied,
					mode,
					openTodos: openTodos.length > 0 ? openTodos : undefined,
				},
			};
		},
	};
}

function shortId(id: string): string {
	return id.length > 12 ? id.slice(0, 12) : id;
}

function validateModeAndSchema(input: {
	mode: "squash" | "jump" | "recover";
	message: string;
	strictSchema: boolean;
}): void {
	const parsed = parseCheckoutMessage(input.message);
	if (input.mode === "jump") {
		if (!parsed.nextStep?.trim()) {
			throw new ToolError(
				`context_checkout message is missing required fields: nextStep\n\n${validateCheckoutSchema(parsed, { strict: false }).template}`,
			);
		}
		return;
	}
	const validation = validateCheckoutSchema(parsed, { strict: input.strictSchema });
	if (!validation.ok) {
		throw new ToolError(
			`context_checkout message is missing required fields: ${validation.missing.join(", ")}\n\n${validation.template}`,
		);
	}
}
