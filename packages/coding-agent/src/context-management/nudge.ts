import type { HealthSnapshot } from "./health";

export interface NudgeState {
	lastNudgeTurn: number;
	lastRecommendation: HealthSnapshot["recommendedAction"];
	lastNudgeAt: number;
}

export function shouldNudge(input: {
	health: HealthSnapshot;
	state: NudgeState | undefined;
	turn: number;
	cooldownTurns: number;
	hasPendingCheckout: boolean;
}): boolean {
	if (input.hasPendingCheckout) return false;
	if (input.health.recommendedAction === "ok") return false;
	const cooldown =
		input.health.level === "urge" ? Math.max(1, Math.floor(input.cooldownTurns / 2)) : input.cooldownTurns;
	if (!input.state) return true;
	if (input.health.recommendedAction !== input.state.lastRecommendation) return true;
	return input.turn - input.state.lastNudgeTurn >= cooldown;
}

export function buildNudge(
	health: HealthSnapshot,
	todos: HealthSnapshot["openTodos"],
): { customType: string; content: string; display: false; details: { health: HealthSnapshot }; attribution: "agent" } {
	const action = recommendedToolAction(health);
	const todoLines =
		todos.length === 0
			? ["  - none"]
			: todos.map(todo => `  - ${todo.phase}: ${todo.inProgress} in_progress, ${todo.pending} pending`);
	return {
		customType: "context-management/health-nudge",
		content: [
			"<context-management-reminder>",
			`Health: ${health.level}`,
			`Reason: ${health.reasons.join(", ") || "none"}`,
			`Action: ${action}`,
			"Open todos:",
			...todoLines,
			"Run context_status to inspect, then act unless the immediate next edit needs the raw history.",
			"</context-management-reminder>",
		].join("\n"),
		display: false,
		details: { health },
		attribution: "agent",
	};
}

function recommendedToolAction(health: HealthSnapshot): string {
	if (health.recommendedAction === "tag") return "context_tag <task>-start";
	if (health.nearestTag) return `context_checkout to ${health.nearestTag} with backupTag <task>-raw`;
	return "context_tag <task>-start, then consider context_checkout after a stable anchor exists";
}
