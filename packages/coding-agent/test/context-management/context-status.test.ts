import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { computeContextHealth } from "@oh-my-pi/pi-coding-agent/context-management/health";
import { setNudgeState } from "@oh-my-pi/pi-coding-agent/context-management/state";
import {
	createContextStatusTool,
	getHealthThresholds,
} from "@oh-my-pi/pi-coding-agent/context-management/tools/context-status";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { makeContext, user } from "./test-utils";

describe("context_status", () => {
	it("returns health JSON matching computeContextHealth", async () => {
		const settings = Settings.isolated({
			"contextManagement.enabled": true,
			"contextManagement.thresholds.stepsWarn": 1,
		});
		const session = SessionManager.inMemory();
		session.appendMessage(user("start"));
		const ctx = makeContext(session, { getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }) });
		const result = await createContextStatusTool(settings).execute("call", {}, undefined, undefined, ctx);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		const parsed = JSON.parse(text) as { recommendedAction: string };
		const expected = computeContextHealth({
			sessionManager: session,
			usage: ctx.getContextUsage(),
			thresholds: getHealthThresholds(settings),
		});
		expect(parsed.recommendedAction).toBe(expected.recommendedAction);
		expect(result.details?.health.recommendedAction).toBe(expected.recommendedAction);
	});

	it("includes nudge history in verbose mode", async () => {
		const settings = Settings.isolated({ "contextManagement.enabled": true });
		const session = SessionManager.inMemory();
		session.appendMessage(user("start"));
		setNudgeState(session.getSessionId(), { lastNudgeTurn: 2, lastRecommendation: "tag", lastNudgeAt: 100 });
		const result = await createContextStatusTool(settings).execute(
			"call",
			{ verbose: true },
			undefined,
			undefined,
			makeContext(session),
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(JSON.parse(text).nudgeHistory.lastRecommendation).toBe("tag");
		expect(result.details?.nudgeHistory?.lastNudgeTurn).toBe(2);
	});
});
