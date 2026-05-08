import { Type } from "@sinclair/typebox";
import type { Settings } from "../../config/settings";
import type { ToolDefinition } from "../../extensibility/extensions";
import { computeContextHealth, type HealthSnapshot, type HealthThresholds } from "../health";
import type { NudgeState } from "../nudge";
import { peekNudgeState } from "../state";

export const contextStatusSchema = Type.Object({
	verbose: Type.Optional(Type.Boolean({ description: "Include recent nudge state for this session." })),
});

export interface ContextStatusDetails {
	health: HealthSnapshot;
	nudgeHistory?: NudgeState;
}

export function createContextStatusTool(
	settings: Settings,
): ToolDefinition<typeof contextStatusSchema, ContextStatusDetails> {
	return {
		name: "context_status",
		label: "Context Status",
		description:
			"Inspect ACM health: usage, segment size, tag distance, tool-output density, error streak, todo state, and recommended next action. Use before deciding whether to tag, squash, or continue.",
		parameters: contextStatusSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const health = computeContextHealth({
				sessionManager: ctx.sessionManager,
				usage: ctx.getContextUsage(),
				thresholds: getHealthThresholds(settings),
			});
			const nudgeHistory = params.verbose ? peekNudgeState(ctx.sessionManager.getSessionId()) : undefined;
			const payload = params.verbose ? { health, nudgeHistory } : health;
			return {
				content: [{ type: "text", text: JSON.stringify(payload) }],
				details: { health, nudgeHistory },
			};
		},
	};
}

export function getHealthThresholds(settings: Settings): HealthThresholds {
	return {
		enabled: settings.get("contextManagement.enabled"),
		usageWarn: settings.get("contextManagement.thresholds.usageWarn"),
		usageUrge: settings.get("contextManagement.thresholds.usageUrge"),
		stepsWarn: settings.get("contextManagement.thresholds.stepsWarn"),
		stepsUrge: settings.get("contextManagement.thresholds.stepsUrge"),
		densityWarn: settings.get("contextManagement.thresholds.densityWarn"),
		densityUrge: settings.get("contextManagement.thresholds.densityUrge"),
		errorsUrge: settings.get("contextManagement.thresholds.errorsUrge"),
	};
}
