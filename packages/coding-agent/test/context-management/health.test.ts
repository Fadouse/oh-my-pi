import { describe, expect, it } from "bun:test";
import { computeContextHealth, type HealthThresholds } from "@oh-my-pi/pi-coding-agent/context-management/health";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { assistantText, erroredToolResult, todoPhasesMessage, toolResult, user } from "./test-utils";

const thresholds: HealthThresholds = {
	enabled: true,
	usageWarn: 50,
	usageUrge: 70,
	stepsWarn: 3,
	stepsUrge: 5,
	densityWarn: 0.6,
	densityUrge: 0.8,
	errorsUrge: 3,
};

describe("computeContextHealth", () => {
	it("returns ok and handles unknown usage when thresholds are not met", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("start"));
		const health = computeContextHealth({ sessionManager: session, usage: undefined, thresholds });
		expect(health.usagePercent).toBeNull();
		expect(health.recommendedAction).toBe("ok");
	});

	it("recommends squash for urgent usage before tag warnings", () => {
		const session = SessionManager.inMemory();
		for (let i = 0; i < 4; i++) session.appendMessage(user(`step ${i}`));
		const health = computeContextHealth({
			sessionManager: session,
			usage: { tokens: 800, contextWindow: 1000, percent: 80 },
			thresholds,
		});
		expect(health.recommendedAction).toBe("squash");
		expect(health.level).toBe("urge");
		expect(health.reasons[0]).toContain("context usage");
	});

	it("recommends tag when an unanchored branch grows past the warning threshold", () => {
		const session = SessionManager.inMemory();
		for (let i = 0; i < 3; i++) session.appendMessage(user(`step ${i}`));
		const health = computeContextHealth({ sessionManager: session, usage: undefined, thresholds });
		expect(health.recommendedAction).toBe("tag");
		expect(health.level).toBe("info");
	});

	it("counts only trailing tool errors", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("start"));
		session.appendMessage(erroredToolResult("bash", "failed", 1));
		session.appendMessage(assistantText("recover", 2));
		session.appendMessage(erroredToolResult("bash", "failed", 3));
		session.appendMessage(erroredToolResult("read", "failed", 4));
		const health = computeContextHealth({ sessionManager: session, usage: undefined, thresholds });
		expect(health.consecutiveErrors).toBe(2);
	});

	it("tracks user milestone distance, density, and open todos", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("start", 1));
		session.appendMessage(toolResult("read", "one", 2));
		session.appendMessage(toolResult("search", "two", 3));
		session.appendMessage(
			todoPhasesMessage(
				[
					{
						name: "Implementation",
						tasks: [
							{ content: "Wire status tool", status: "in_progress" },
							{ content: "Run focused tests", status: "pending" },
						],
					},
				],
				4,
			),
		);
		const health = computeContextHealth({ sessionManager: session, usage: undefined, thresholds });
		expect(health.turnsSinceUserMilestone).toBe(3);
		expect(health.toolResultDensity).toBe(0.75);
		expect(health.openTodos).toEqual([{ phase: "Implementation", pending: 1, inProgress: 1 }]);
	});
});
