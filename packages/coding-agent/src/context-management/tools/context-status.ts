import { Type } from "@sinclair/typebox";
import type { Settings } from "../../config/settings";
import type { ToolDefinition } from "../../extensibility/extensions";
import { computeContextHealth, type HealthSnapshot, type HealthThresholds } from "../health";
import type { NudgeState } from "../nudge";
import { type ParsedCheckoutMessage, parseCheckoutMessage, validateCheckoutSchema } from "../schema";
import { type PendingCheckout, peekNudgeState, peekPending } from "../state";

export const contextStatusSchema = Type.Object({
	verbose: Type.Optional(Type.Boolean({ description: "Include recent nudge state for this session." })),
});

export interface ContextStatusDetails {
	health: HealthSnapshot;
	nudgeHistory?: NudgeState;
	pendingCheckout?: PendingCheckoutStatus;
}

interface PendingCheckoutStatus {
	present: boolean;
	mode?: PendingCheckout["mode"];
	origin?: string;
	summaryEntryId?: string;
	navigateTargetId?: string;
	handoff?: {
		ok: boolean;
		missing: string[];
		parsed: ParsedCheckoutMessage;
	};
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
			try {
				const health = computeContextHealth({
					sessionManager: ctx.sessionManager,
					usage: ctx.getContextUsage(),
					thresholds: getHealthThresholds(settings),
				});
				const nudgeHistory = params.verbose ? peekNudgeState(ctx.sessionManager.getSessionId()) : undefined;
				const pendingCheckout = params.verbose
					? describePendingCheckout(ctx.sessionManager.getSessionId())
					: undefined;
				const payload = params.verbose ? { health, nudgeHistory, pendingCheckout } : health;
				return {
					content: [{ type: "text", text: JSON.stringify(payload) }],
					details: { health, nudgeHistory, pendingCheckout },
				};
			} catch (error) {
				const payload = {
					error: "context_status_failed",
					message: error instanceof Error ? error.message : String(error),
				};
				return { content: [{ type: "text", text: JSON.stringify(payload) }], details: undefined };
			}
		},
	};
}

function describePendingCheckout(sid: string): PendingCheckoutStatus {
	const pending = peekPending(sid);
	if (!pending) return { present: false };
	const parsed = parseCheckoutMessage(pending.enrichedMessage);
	const validation = validateCheckoutSchema(parsed, { strict: true });
	return {
		present: true,
		mode: pending.mode,
		origin: pending.origin,
		summaryEntryId: pending.summaryEntryId,
		navigateTargetId: pending.navigateTargetId,
		handoff: { ok: validation.ok, missing: validation.missing, parsed },
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
