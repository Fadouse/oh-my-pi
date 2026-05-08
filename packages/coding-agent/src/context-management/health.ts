import type { ContextUsage } from "../extensibility/extensions";
import type { ReadonlySessionManager, SessionEntry } from "../session/session-manager";
import { getLatestTodoPhasesWithSource, type TodoPhaseSource } from "../tools/todo-write";
import { consecutiveTrailingErrors, recentToolResultDensity, turnsSinceUserMilestone } from "./helpers";

export type ContextHealthAction = "ok" | "tag" | "squash" | "recover";
export type ContextHealthLevel = "ok" | "info" | "warn" | "urge";

export interface HealthThresholds {
	enabled: boolean;
	usageWarn: number;
	usageUrge: number;
	stepsWarn: number;
	stepsUrge: number;
	densityWarn: number;
	densityUrge: number;
	errorsUrge: number;
}

export interface HealthSnapshot {
	usagePercent: number | null;
	usageTokens: number | null;
	contextWindow: number | null;
	stepsSinceTag: number;
	nearestTag: string | null;
	toolResultDensity: number;
	hiddenInBranch: number;
	consecutiveErrors: number;
	turnsSinceUserMilestone: number;
	openTodos: { phase: string; pending: number; inProgress: number }[];
	openTodosSource: TodoPhaseSource;
	recommendedAction: ContextHealthAction;
	reasons: string[];
	level: ContextHealthLevel;
}

export function computeContextHealth(input: {
	sessionManager: ReadonlySessionManager;
	usage: ContextUsage | undefined;
	thresholds: HealthThresholds;
}): HealthSnapshot {
	const branch = input.sessionManager.getBranch();
	const tagDistance = distanceToNearestTag(input.sessionManager);
	const usagePercent = input.usage?.percent ?? null;
	const usageTokens = input.usage?.tokens ?? null;
	const contextWindow = input.usage?.contextWindow ?? null;
	const toolResultDensity = recentToolResultDensity(branch, 20);
	const consecutiveErrors = consecutiveTrailingErrors(branch);
	const userMilestoneDistance = turnsSinceUserMilestone(branch);
	const openTodosResult = summarizeOpenTodos(branch);
	const hiddenInBranch = branch.filter(entry => entry.type === "custom_message").length;

	const base: Omit<HealthSnapshot, "recommendedAction" | "reasons" | "level"> = {
		usagePercent,
		usageTokens,
		contextWindow,
		stepsSinceTag: tagDistance.stepsSinceTag,
		nearestTag: tagDistance.nearestTag,
		toolResultDensity,
		hiddenInBranch,
		consecutiveErrors,
		turnsSinceUserMilestone: userMilestoneDistance,
		openTodos: openTodosResult.openTodos,
		openTodosSource: openTodosResult.source,
	};

	if (!input.thresholds.enabled) {
		return { ...base, recommendedAction: "ok", reasons: [], level: "ok" };
	}

	const urgentReasons: string[] = [];
	if (usagePercent !== null && usagePercent >= input.thresholds.usageUrge) {
		urgentReasons.push(`context usage ${usagePercent.toFixed(1)}% >= ${input.thresholds.usageUrge}%`);
	}
	if (tagDistance.stepsSinceTag >= input.thresholds.stepsUrge) {
		urgentReasons.push(`segment has ${tagDistance.stepsSinceTag} steps since last tag`);
	}
	if (toolResultDensity >= input.thresholds.densityUrge && userMilestoneDistance >= input.thresholds.stepsWarn) {
		urgentReasons.push(`tool density ${(toolResultDensity * 100).toFixed(0)}% over recent history`);
	}
	if (consecutiveErrors >= input.thresholds.errorsUrge) {
		urgentReasons.push(`${consecutiveErrors} consecutive tool errors`);
	}

	if (urgentReasons.length > 0) {
		return { ...base, recommendedAction: "squash", reasons: urgentReasons, level: "urge" };
	}
	if (tagDistance.nearestTag === null && tagDistance.stepsSinceTag >= input.thresholds.stepsWarn) {
		return {
			...base,
			recommendedAction: "tag",
			reasons: [`no anchor and segment has ${tagDistance.stepsSinceTag} steps`],
			level: "info",
		};
	}
	return { ...base, recommendedAction: "ok", reasons: [], level: "ok" };
}

function distanceToNearestTag(sm: ReadonlySessionManager): { stepsSinceTag: number; nearestTag: string | null } {
	const branch = sm.getBranch();
	let stepsSinceTag = 0;
	for (let i = branch.length - 1; i >= 0; i--) {
		const label = sm.getLabel(branch[i].id);
		if (label) return { stepsSinceTag, nearestTag: label };
		stepsSinceTag++;
	}
	return { stepsSinceTag, nearestTag: null };
}

function summarizeOpenTodos(branch: SessionEntry[]): {
	openTodos: HealthSnapshot["openTodos"];
	source: TodoPhaseSource;
} {
	const result = getLatestTodoPhasesWithSource(branch);
	return {
		source: result.source,
		openTodos: result.phases
			.map(phase => ({
				phase: phase.name,
				pending: phase.tasks.filter(task => task.status === "pending").length,
				inProgress: phase.tasks.filter(task => task.status === "in_progress").length,
			}))
			.filter(phase => phase.pending > 0 || phase.inProgress > 0),
	};
}
