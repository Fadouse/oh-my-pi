import { Type } from "@sinclair/typebox";
import { Settings } from "../../config/settings";
import type { ContextUsage, ToolDefinition } from "../../extensibility/extensions";
import type { SessionEntry, SessionManager } from "../../session/session-manager";
import { computeContextHealth, type HealthSnapshot } from "../health";
import { entryRole, getMessagePreview, normalizePreview } from "../helpers";
import { getHealthThresholds } from "./context-status";

export const contextLogSchema = Type.Object({
	limit: Type.Optional(Type.Number({ description: "History limit for visible entries (default: 50)." })),
	verbose: Type.Optional(
		Type.Boolean({
			description:
				"If true, show all messages. If false (default), collapses intermediate AI steps and only shows milestones: user messages, tags, branch points, and summaries.",
		}),
	),
});

export interface ContextLogDetails {
	visibleEntries: number;
	hiddenEntries: number;
	health: HealthSnapshot;
}

export function createContextLogTool(
	configuredSettings?: Settings,
): ToolDefinition<typeof contextLogSchema, ContextLogDetails> {
	return {
		name: "context_log",
		label: "Context Log",
		description:
			"Show the history structure (status, messages, tags, milestones). Analogous to git log --graph --oneline --decorate.",
		parameters: contextLogSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const runtimeSettings = configuredSettings ?? Settings.isolated({ "contextManagement.enabled": true });
			const sm = ctx.sessionManager as SessionManager;
			const branch = sm.getBranch();
			const currentLeafId = sm.getLeafId();
			const verbose = params.verbose ?? false;
			const limit = params.limit ?? 50;
			const backboneIds = new Set(branch.map(entry => entry.id));
			const sequence: SessionEntry[] = [];

			for (const entry of branch) {
				sequence.push(entry);
				for (const child of sm.getChildren(entry.id)) {
					if ((child.type === "branch_summary" || child.type === "compaction") && !backboneIds.has(child.id)) {
						sequence.push(child);
					}
				}
			}

			let visibleEntries = sequence.filter(entry => verbose || isInteresting(entry, sm, branch, currentLeafId));
			if (visibleEntries.length > limit) visibleEntries = visibleEntries.slice(-limit);
			const visibleSequenceIds = new Set(visibleEntries.map(entry => entry.id));

			const lines: string[] = [];
			let hiddenCount = 0;
			let hiddenTotal = 0;

			for (const entry of sequence) {
				if (!visibleSequenceIds.has(entry.id)) {
					hiddenCount++;
					hiddenTotal++;
					continue;
				}
				if (hiddenCount > 0) {
					lines.push(`  :  ... (${hiddenCount} hidden messages) ...`);
					hiddenCount = 0;
				}

				const role = entryRole(entry);
				if (role === "CUSTOM_MESSAGE") continue;
				const isHead = entry.id === currentLeafId;
				const isRoot = branch.length > 0 && entry.id === branch[0].id;
				const label = sm.getLabel(entry.id);
				const meta = [isRoot ? "ROOT" : null, isHead ? "HEAD" : null, label ? `tag: ${label}` : null]
					.filter((part): part is string => part !== null)
					.join(", ");
				const marker = isHead ? "*" : role === "USER" ? "•" : "|";
				const body = normalizePreview(getMessagePreview(entry, sm, verbose));
				lines.push(`${marker} ${entry.id}${meta ? ` (${meta})` : ""} [${role}] ${body}`.trimEnd());
			}

			if (hiddenCount > 0) lines.push(`  :  ... (${hiddenCount} hidden messages) ...`);

			const health = computeContextHealth({
				sessionManager: sm,
				usage: ctx.getContextUsage(),
				thresholds: getHealthThresholds(runtimeSettings),
			});
			const hud = [
				"[Context Dashboard]",
				`• Context Usage:    ${formatUsage(ctx.getContextUsage())}`,
				`• Segment Size:     ${segmentSize(branch, sm)}`,
				`• Tool density:     ${(health.toolResultDensity * 100).toFixed(0)}% of last 20 entries`,
				`• Error streak:     ${health.consecutiveErrors}`,
				`• User milestone:   ${health.turnsSinceUserMilestone} entries ago`,
				`• Open todos:       ${formatOpenTodos(health.openTodos)} (source: ${health.openTodosSource})`,
				`• Recommendation:   ${health.recommendedAction}${health.reasons.length > 0 ? ` (${health.reasons.join("; ")})` : ""}`,
				"---------------------------------------------------",
			].join("\n");

			return {
				content: [{ type: "text", text: `${hud}\n${lines.join("\n") || "(Root Path Only)"}` }],
				details: { visibleEntries: visibleEntries.length, hiddenEntries: hiddenTotal, health },
			};
		},
	};
}

function isInteresting(
	entry: SessionEntry,
	sm: SessionManager,
	branch: SessionEntry[],
	currentLeafId: string | null,
): boolean {
	if (entry.id === currentLeafId) return true;
	if (branch.length > 0 && entry.id === branch[0].id) return true;
	if (sm.getLabel(entry.id)) return true;
	if (entry.type === "label" || entry.type === "custom_message") return false;
	if (entry.type === "branch_summary" || entry.type === "compaction") return true;
	if (sm.getChildren(entry.id).length > 1) return true;
	return entry.type === "message" && entry.message.role === "user";
}

function formatUsage(usage: ContextUsage | undefined): string {
	if (!usage || usage.tokens === null || usage.percent === null) return "Unknown";
	return `${usage.percent.toFixed(1)}% (${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)})`;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}m`;
}

function segmentSize(branch: SessionEntry[], sm: SessionManager): string {
	let stepsSinceTag = 0;
	let nearestTagName = "None";
	for (let i = branch.length - 1; i >= 0; i--) {
		const label = sm.getLabel(branch[i].id);
		if (label) {
			nearestTagName = label;
			break;
		}
		stepsSinceTag++;
	}
	return `${stepsSinceTag} steps since last tag '${nearestTagName}'`;
}

function formatOpenTodos(openTodos: HealthSnapshot["openTodos"]): string {
	if (openTodos.length === 0) return "none";
	return openTodos.map(todo => `${todo.phase} ${todo.inProgress} in_progress, ${todo.pending} pending`).join("; ");
}
