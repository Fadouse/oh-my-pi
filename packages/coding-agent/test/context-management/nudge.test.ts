import { describe, expect, it } from "bun:test";
import type { HealthSnapshot } from "@oh-my-pi/pi-coding-agent/context-management/health";
import { buildNudge, shouldNudge } from "@oh-my-pi/pi-coding-agent/context-management/nudge";
import {
	clearAllNudgesForTests,
	peekNudgeState,
	setNudgeState,
} from "@oh-my-pi/pi-coding-agent/context-management/state";

const baseHealth: HealthSnapshot = {
	usagePercent: null,
	usageTokens: null,
	contextWindow: null,
	stepsSinceTag: 30,
	nearestTag: "task-start",
	toolResultDensity: 0,
	hiddenInBranch: 0,
	consecutiveErrors: 0,
	turnsSinceUserMilestone: 10,
	openTodos: [],
	recommendedAction: "squash",
	reasons: ["segment is long"],
	level: "warn",
};

describe("context-management nudges", () => {
	it("suppresses ok health and pending checkout", () => {
		expect(
			shouldNudge({
				health: { ...baseHealth, recommendedAction: "ok" },
				state: undefined,
				turn: 1,
				cooldownTurns: 3,
				hasPendingCheckout: false,
			}),
		).toBe(false);
		expect(
			shouldNudge({ health: baseHealth, state: undefined, turn: 1, cooldownTurns: 3, hasPendingCheckout: true }),
		).toBe(false);
	});

	it("debounces repeated recommendations but allows changed recommendations", () => {
		const state = { lastNudgeTurn: 10, lastRecommendation: "squash" as const, lastNudgeAt: 1000 };
		expect(shouldNudge({ health: baseHealth, state, turn: 12, cooldownTurns: 3, hasPendingCheckout: false })).toBe(
			false,
		);
		expect(shouldNudge({ health: baseHealth, state, turn: 13, cooldownTurns: 3, hasPendingCheckout: false })).toBe(
			true,
		);
		expect(
			shouldNudge({
				health: { ...baseHealth, recommendedAction: "tag", level: "info" },
				state,
				turn: 11,
				cooldownTurns: 3,
				hasPendingCheckout: false,
			}),
		).toBe(true);
	});

	it("halves cooldown for urgent nudges", () => {
		const state = { lastNudgeTurn: 10, lastRecommendation: "squash" as const, lastNudgeAt: 1000 };
		const urgent = { ...baseHealth, level: "urge" as const };
		expect(shouldNudge({ health: urgent, state, turn: 11, cooldownTurns: 4, hasPendingCheckout: false })).toBe(false);
		expect(shouldNudge({ health: urgent, state, turn: 12, cooldownTurns: 4, hasPendingCheckout: false })).toBe(true);
	});

	it("keeps nudge state isolated by session", () => {
		clearAllNudgesForTests();
		setNudgeState("a", { lastNudgeTurn: 1, lastRecommendation: "tag", lastNudgeAt: 100 });
		expect(peekNudgeState("a")?.lastRecommendation).toBe("tag");
		expect(peekNudgeState("b")).toBeUndefined();
	});

	it("builds hidden structured reminder content", () => {
		const nudge = buildNudge({ ...baseHealth, openTodos: [{ phase: "Implementation", pending: 1, inProgress: 1 }] }, [
			{ phase: "Implementation", pending: 1, inProgress: 1 },
		]);
		expect(nudge.display).toBe(false);
		expect(nudge.customType).toBe("context-management/health-nudge");
		expect(nudge.content).toContain("context_checkout to task-start");
		expect(nudge.content).toContain("Implementation: 1 in_progress, 1 pending");
	});
});
