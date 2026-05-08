import { logger } from "@oh-my-pi/pi-utils";
import { settings as globalSettings, type Settings } from "../config/settings";
import type { ExtensionFactory } from "../extensibility/extensions";
import checkoutFollowup from "./prompts/checkout-followup.md" with { type: "text" };
import contextManagementSystemPrompt from "./prompts/system.md" with { type: "text" };
import { clearSession, type PendingCheckout, peekPending, takePending } from "./state";
import { createContextCheckoutTool } from "./tools/context-checkout";
import { createContextLogTool } from "./tools/context-log";
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
	api.registerTool(createContextLogTool());
	api.registerTool(createContextCheckoutTool(api));

	api.on("before_agent_start", event => ({
		systemPrompt: appendContextManagementSystemPrompt(event.systemPrompt),
	}));

	api.on("turn_end", (_event, ctx) => {
		if (peekPending(ctx.sessionManager.getSessionId())) ctx.abort();
	});

	api.on("agent_end", async (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		const pending = takePending(sid);
		if (!pending) return;
		try {
			await ctx.navigateTree(pending.summaryEntryId, { summarize: false });
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
