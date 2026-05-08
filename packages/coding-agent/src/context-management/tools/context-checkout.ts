import { logger } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import { Settings } from "../../config/settings";
import type { ExtensionAPI, ToolDefinition } from "../../extensibility/extensions";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry, SessionManager } from "../../session/session-manager";
import { getLatestTodoPhasesFromEntries, type TodoPhase } from "../../tools/todo-write";
import { ToolError } from "../../tools/tool-errors";
import { resolveTargetId } from "../helpers";
import { parseCheckoutMessage, validateCheckoutSchema } from "../schema";
import { clearPending, setPending } from "../state";

export const contextCheckoutSchema = Type.Object({
	target: Type.Optional(
		Type.String({
			description:
				"Legacy checkout target. Can be a tag name (e.g., 'task-start'), entry ID, or 'root'. Use either target, or startId/endId for range checkout.",
		}),
	),
	startId: Type.Optional(
		Type.String({
			description:
				"Range checkout start boundary. Use an entry ID visible in context_log. By default, this entry must be immediately after a tagged checkpoint; the selected range is inclusive.",
		}),
	),
	endId: Type.Optional(
		Type.String({
			description:
				"Range checkout end boundary. May be any entry on the current branch at or after startId; later entries are replayed after the summary.",
		}),
	),
	topic: Type.Optional(
		Type.String({ description: "Short label for the checkout range, used for display and history." }),
	),
	allowUntaggedStart: Type.Optional(
		Type.Boolean({
			description:
				"Unsafe escape hatch for range checkout. By default, startId must be immediately after an existing context_tag anchor. Set true only when no usable anchor exists.",
		}),
	),
	message: Type.String({
		description:
			"Complete handoff for the new branch. MUST preserve objective, user constraints, Current Artifact, decisions, state, next step, and recovery tag. MUST NOT paste raw transcript or tool dumps.",
	}),
	backupTag: Type.Optional(
		Type.String({
			description:
				"Tag to apply to the current leaf before checkout. Use it to recover raw context if the handoff is incomplete.",
		}),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("squash"), Type.Literal("jump"), Type.Literal("recover")], {
			description:
				"Checkout mode. squash creates a handoff summary; jump moves with relaxed schema; recover restores a known backup tag when a summary lost required context.",
		}),
	),
});

export interface ContextCheckoutDetails {
	targetId?: string;
	summaryEntryId?: string;
	backupTagApplied?: string;
	mode?: "squash" | "jump" | "recover";
	range?: {
		topic?: string;
		startId: string;
		endId: string;
		startRef: string;
		endRef: string;
		parentId: string | null;
		anchorTagId?: string;
		anchorTagName?: string;
		untaggedStartAllowed?: boolean;
		entryIds: string[];
		suffixEntryIds: string[];
		replayedSuffixEntryIds?: string[];
	};
	openTodos?: TodoPhase[];
}

export function createContextCheckoutTool(
	_api: ExtensionAPI,
	configuredSettings?: Settings,
): ToolDefinition<typeof contextCheckoutSchema, ContextCheckoutDetails> {
	return {
		name: "context_checkout",
		label: "Context Checkout",
		description:
			"Archive a model-selected conversation range into a compact checkout summary, then replace current context with that summary. Use startId/endId for range checkout; legacy target checkout remains for recovery/navigation.",
		parameters: contextCheckoutSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const runtimeSettings = configuredSettings ?? Settings.isolated({ "contextManagement.enabled": true });
			const sm = ctx.sessionManager as SessionManager;
			clearPending(sm.getSessionId());
			const targetParamInput = normalizeOptionalParam(params.target);
			const startParam = normalizeOptionalParam(params.startId);
			const endParam = normalizeOptionalParam(params.endId);
			const topic = normalizeOptionalParam(params.topic);
			const backupTag = normalizeOptionalParam(params.backupTag);
			const currentLeaf = sm.getLeafId();
			const mode = params.mode ?? "squash";
			const rangeMode = startParam !== undefined || endParam !== undefined;
			if (rangeMode && targetParamInput !== undefined) {
				throw new ToolError("context_checkout accepts either target or startId/endId, not both");
			}
			if (rangeMode && mode === "recover") {
				throw new ToolError("Recover mode requires target; range checkout only supports squash/jump");
			}

			const checkoutTarget = rangeMode
				? resolveRangeCheckoutTarget(sm, startParam, endParam, topic, {
						allowUntaggedStart: params.allowUntaggedStart === true || mode === "jump",
					})
				: undefined;
			const targetParam = targetParamInput ?? checkoutTarget?.parentRef;
			if (!targetParam) {
				throw new ToolError("context_checkout requires either target or both startId and endId");
			}
			const targetId = checkoutTarget?.parentId ?? resolveTargetId(sm, targetParam);
			if (!checkoutTarget && currentLeaf === targetId) {
				return { content: [{ type: "text", text: `Already at target ${targetId}` }], details: { targetId } };
			}
			if (targetId !== "root" && !sm.getEntry(targetId)) {
				throw new ToolError(`context_checkout target not found: ${targetParam} (resolved to ${targetId})`);
			}

			validateModeAndSchema({
				mode,
				message: params.message,
				strictSchema: runtimeSettings.get("contextManagement.checkout.strictSchema"),
			});

			if (mode === "recover") {
				const targetLabel = sm.getLabel(targetId);
				if (!targetLabel || targetLabel !== targetParamInput) {
					throw new ToolError(`Recover mode requires a known tag target; got ${targetParamInput}`);
				}
				const sid = sm.getSessionId();
				const previous = setPending(sid, {
					targetId,
					summaryEntryId: targetId,
					enrichedMessage: params.message,
					backupTagApplied: undefined,
					origin: `tag: ${targetLabel}`,
					rawTarget: targetParamInput ?? targetId,
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
							text: `Recover checkout staged. Aborting current turn; will restore tag ${targetParamInput}.`,
						},
					],
					details: { targetId, summaryEntryId: targetId, mode },
				};
			}

			let backupTagApplied: string | undefined;
			if (backupTag && currentLeaf) {
				sm.appendLabelChange(currentLeaf, backupTag);
				backupTagApplied = backupTag;
			}

			const origin = checkoutTarget
				? `range ${checkoutTarget.startRef}..${checkoutTarget.endRef}`
				: sm.getLabel(targetId)
					? `tag: ${sm.getLabel(targetId)}`
					: shortId(targetId);
			const enrichedMessage = `(summary from ${origin})\n${params.message}`;
			const openTodos = runtimeSettings.get("contextManagement.todoCoupling")
				? getLatestTodoPhasesFromEntries(sm.getBranch())
				: [];
			const summaryDetails: {
				source: "context_checkout";
				backupTag: string | undefined;
				target: string;
				mode: "squash" | "jump" | "recover";
				range?: ContextCheckoutDetails["range"];
				openTodos?: TodoPhase[];
			} = {
				source: "context_checkout",
				backupTag,
				target: targetParam,
				mode,
				...(checkoutTarget ? { range: checkoutTarget.range } : {}),
			};
			if (openTodos.length > 0) summaryDetails.openTodos = openTodos;
			const summaryEntryId = sm.branchWithSummary(
				checkoutTarget ? checkoutTarget.parentId : targetId,
				enrichedMessage,
				summaryDetails,
				true,
			);
			const replayedSuffixEntryIds = checkoutTarget ? replaySuffixEntries(sm, checkoutTarget.suffixEntries) : [];
			const navigateTargetId = replayedSuffixEntryIds.at(-1) ?? summaryEntryId;

			const sid = sm.getSessionId();
			const previous = setPending(sid, {
				targetId,
				summaryEntryId,
				enrichedMessage,
				backupTagApplied,
				origin,
				rawTarget: targetParam,
				mode,
				navigateTargetId,
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
						text: checkoutTarget
							? `Range checkout staged. Aborting current turn; will replace ${checkoutTarget.startRef}..${checkoutTarget.endRef} with summary.`
							: `Checkout staged. Aborting current turn; will rebase on ${targetParam}.`,
					},
				],
				details: {
					targetId,
					summaryEntryId,
					backupTagApplied,
					mode,
					range: checkoutTarget ? { ...checkoutTarget.range, replayedSuffixEntryIds } : undefined,
					openTodos: openTodos.length > 0 ? openTodos : undefined,
				},
			};
		},
	};
}

function shortId(id: string): string {
	return id.length > 12 ? id.slice(0, 12) : id;
}

interface ResolvedRangeCheckoutTarget {
	parentId: string | null;
	parentRef: string;
	startRef: string;
	endRef: string;
	range: NonNullable<ContextCheckoutDetails["range"]>;
	suffixEntries: SessionEntry[];
}

function resolveRangeCheckoutTarget(
	sm: SessionManager,
	startParam: string | undefined,
	endParam: string | undefined,
	topic: string | undefined,
	options: { allowUntaggedStart: boolean },
): ResolvedRangeCheckoutTarget {
	if (!startParam || !endParam) {
		throw new ToolError("Range checkout requires both startId and endId");
	}

	const startId = resolveTargetId(sm, startParam);
	const endId = resolveTargetId(sm, endParam);
	const branch = sm.getBranch();
	const startIndex = branch.findIndex(entry => entry.id === startId);
	const endIndex = branch.findIndex(entry => entry.id === endId);
	if (startIndex < 0) {
		throw new ToolError(
			`context_checkout startId not found on current branch: ${startParam} (resolved to ${startId})`,
		);
	}
	if (endIndex < 0) {
		throw new ToolError(`context_checkout endId not found on current branch: ${endParam} (resolved to ${endId})`);
	}
	if (startIndex > endIndex) {
		throw new ToolError(`context_checkout range is invalid: startId ${startParam} appears after endId ${endParam}`);
	}

	const startEntry = branch[startIndex] as SessionEntry | undefined;
	if (!startEntry) {
		throw new ToolError(`context_checkout failed to resolve range start: ${startParam}`);
	}
	const selectedEntries = branch.slice(startIndex, endIndex + 1);
	const suffixEntries = branch.slice(endIndex + 1);
	const parentId = startEntry.parentId;
	const anchor = resolveRangeAnchor(sm, parentId);
	if (!anchor && !options.allowUntaggedStart) {
		throw new ToolError(
			`Range checkout startId must be immediately after a tagged checkpoint. Tag the entry before ${startParam} with context_tag, choose a startId after the nearest tag, or set allowUntaggedStart only when no safe anchor exists.`,
		);
	}
	return {
		parentId,
		parentRef: parentId ?? "root",
		startRef: startParam,
		endRef: endParam,
		range: {
			...(topic ? { topic } : {}),
			startId,
			endId,
			startRef: startParam,
			endRef: endParam,
			parentId,
			...(anchor ? { anchorTagId: anchor.id, anchorTagName: anchor.name } : {}),
			...(!anchor && options.allowUntaggedStart ? { untaggedStartAllowed: true } : {}),
			entryIds: selectedEntries.map(entry => entry.id),
			suffixEntryIds: suffixEntries.map(entry => entry.id),
		},
		suffixEntries,
	};
}

function resolveRangeAnchor(sm: SessionManager, parentId: string | null): { id: string; name: string } | undefined {
	if (!parentId) return undefined;
	const directLabel = sm.getLabel(parentId);
	if (directLabel) return { id: parentId, name: directLabel };
	const parentEntry = sm.getEntry(parentId);
	if (parentEntry?.type === "label" && parentEntry.label) {
		return { id: parentEntry.targetId, name: parentEntry.label };
	}
	return undefined;
}

function replaySuffixEntries(sm: SessionManager, entries: SessionEntry[]): string[] {
	const replayedIds: string[] = [];
	for (const entry of entries) {
		replayedIds.push(replayEntry(sm, entry));
	}
	return replayedIds;
}

function replayEntry(sm: SessionManager, entry: SessionEntry): string {
	switch (entry.type) {
		case "message": {
			const message = structuredClone(entry.message);
			if (message.role === "branchSummary") {
				return sm.branchWithSummary(sm.getLeafId(), message.summary, undefined, true);
			}
			if (message.role === "compactionSummary") {
				return sm.appendCompaction(message.summary, message.shortSummary, sm.getLeafId() ?? "", 0, undefined, true);
			}
			return sm.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
		}
		case "custom":
			return sm.appendCustomEntry(entry.customType, structuredClone(entry.data));
		case "custom_message":
			return sm.appendCustomMessageEntry(
				entry.customType,
				structuredClone(entry.content),
				entry.display,
				structuredClone(entry.details),
				entry.attribution,
			);
		case "thinking_level_change":
			return sm.appendThinkingLevelChange(entry.thinkingLevel ?? undefined);
		case "service_tier_change":
			return sm.appendServiceTierChange(entry.serviceTier);
		case "model_change":
			return sm.appendModelChange(entry.model, entry.role);
		case "mode_change":
			return sm.appendModeChange(entry.mode, structuredClone(entry.data));
		case "ttsr_injection":
			return sm.appendTtsrInjection([...entry.injectedRules]);
		case "mcp_tool_selection":
			return sm.appendMCPToolSelection([...entry.selectedToolNames]);
		case "session_init":
			return sm.appendSessionInit(structuredClone(entry));
		case "branch_summary": {
			const summary = entry as BranchSummaryEntry;
			return sm.branchWithSummary(
				sm.getLeafId(),
				summary.summary,
				structuredClone(summary.details),
				summary.fromExtension,
			);
		}
		case "compaction": {
			const compaction = entry as CompactionEntry;
			return sm.appendCompaction(
				compaction.summary,
				compaction.shortSummary,
				compaction.firstKeptEntryId,
				compaction.tokensBefore,
				structuredClone(compaction.details),
				compaction.fromExtension,
				structuredClone(compaction.preserveData),
			);
		}
		case "label":
			return sm.appendLabelChange(entry.targetId, entry.label);
	}
}

function normalizeOptionalParam(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
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
