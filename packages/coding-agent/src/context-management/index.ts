import { logger } from "@oh-my-pi/pi-utils";
import { settings as globalSettings, type Settings } from "../config/settings";
import type { ExtensionFactory } from "../extensibility/extensions";
import { computeContextHealth } from "./health";
import { buildNudge, shouldNudge } from "./nudge";
import checkoutFollowup from "./prompts/checkout-followup.md" with { type: "text" };
import contextManagementSystemPrompt from "./prompts/system.md" with { type: "text" };
import { clearSession, type PendingCheckout, peekNudgeState, peekPending, setNudgeState, takePending } from "./state";
import { createContextCheckoutTool } from "./tools/context-checkout";
import { createContextLogTool } from "./tools/context-log";
import { createContextSearchTool } from "./tools/context-search";
import { createContextStatusTool, getHealthThresholds } from "./tools/context-status";
import { createContextTagTool } from "./tools/context-tag";

export const createContextManagementExtension: ExtensionFactory = api =>
	createContextManagementExtensionWithSettings(api);

export const createContextManagementExtensionWithSettings = (
	api: Parameters<ExtensionFactory>[0],
	configuredSettings?: Settings,
): void => {
	const runtimeSettings = configuredSettings ?? globalSettings;
	if (!runtimeSettings.get("contextManagement.enabled")) return;

	api.registerTool(createContextTagTool(api));
	api.registerTool(createContextLogTool(runtimeSettings));
	api.registerTool(createContextSearchTool(runtimeSettings));
	api.registerTool(createContextCheckoutTool(api, runtimeSettings));
	api.registerTool(createContextStatusTool(runtimeSettings));

	api.on("before_agent_start", (event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		const health = computeContextHealth({
			sessionManager: ctx.sessionManager,
			usage: ctx.getContextUsage(),
			thresholds: getHealthThresholds(runtimeSettings),
		});
		const turn = ctx.sessionManager.getBranch().length;
		const nudge =
			runtimeSettings.get("contextManagement.nudges") &&
			shouldNudge({
				health,
				state: peekNudgeState(sid),
				turn,
				cooldownTurns: runtimeSettings.get("contextManagement.nudges.cooldownTurns"),
				hasPendingCheckout: Boolean(peekPending(sid)),
			});
		if (nudge) {
			setNudgeState(sid, {
				lastNudgeTurn: turn,
				lastRecommendation: health.recommendedAction,
				lastNudgeAt: Date.now(),
			});
		}
		return {
			systemPrompt: appendContextManagementSystemPrompt(event.systemPrompt),
			message: nudge ? buildNudge(health, health.openTodos) : undefined,
		};
	});

	api.on("turn_end", (_event, ctx) => {
		if (peekPending(ctx.sessionManager.getSessionId())) ctx.abort();
	});

	api.on("tool_result", (event, ctx) => {
		if (!runtimeSettings.get("contextManagement.todoCoupling")) return;
		if (event.toolName !== "todo_write" || event.isError) return;
		const details = event.details as { phases?: Array<{ tasks?: Array<{ status?: string }> }> } | undefined;
		const phases = details?.phases ?? [];
		const hasTasks = phases.some(phase => (phase.tasks ?? []).length > 0);
		const allComplete =
			hasTasks &&
			phases.every(phase =>
				(phase.tasks ?? []).every(task => task.status === "completed" || task.status === "abandoned"),
			);
		if (!allComplete) return;
		setNudgeState(ctx.sessionManager.getSessionId(), {
			lastNudgeTurn: Number.NEGATIVE_INFINITY,
			lastRecommendation: "squash",
			lastNudgeAt: Date.now(),
		});
	});
	api.on("agent_end", async (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		const pending = takePending(sid);
		if (!pending) return;
		try {
			await ctx.navigateTree(pending.navigateTargetId ?? pending.summaryEntryId, { summarize: false });
		} catch (error) {
			logger.warn("context-management: checkout navigation failed", {
				sid,
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		ctx.ui.notify(formatCheckoutNotification(pending), "info");
		api.sendMessage(
			{
				customType: "context-management/checkout-complete",
				content: checkoutFollowup,
				display: false,
				attribution: "agent",
			},
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
	});

	api.on("session_shutdown", (_event, ctx) => clearSession(ctx.sessionManager.getSessionId()));
};

function formatCheckoutNotification(pending: PendingCheckout): string {
	const targetSuffix = pending.rawTarget === pending.targetId ? "" : ` (${pending.targetId})`;
	return [
		`Checked out ${pending.rawTarget}${targetSuffix}`,
		`Backup tag created: ${pending.backupTagApplied ?? "none"}`,
		`message: ${pending.enrichedMessage}`,
	].join("\n");
}

function appendContextManagementSystemPrompt(systemPrompt: string[]): string[] {
	if (systemPrompt.length === 0) return [contextManagementSystemPrompt];
	const next = [...systemPrompt];
	next[next.length - 1] = `${next[next.length - 1]}\n\n${contextManagementSystemPrompt}`;
	return next;
}
