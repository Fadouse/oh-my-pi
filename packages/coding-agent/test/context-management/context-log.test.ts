import { describe, expect, it } from "bun:test";
import { createContextLogTool } from "@oh-my-pi/pi-coding-agent/context-management/tools/context-log";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { assistantText, makeContext, todoPhasesMessage, toolResult, user } from "./test-utils";

describe("context_log", () => {
	it("renders markers, tag metadata, hidden gaps, and usage HUD", async () => {
		const session = SessionManager.inMemory();
		const root = session.appendMessage(user("root task", 1));
		session.appendLabelChange(root, "task-start");
		session.appendMessage(assistantText("internal reasoning", 2));
		session.appendMessage(user("next request", 3));
		const tool = createContextLogTool();
		const ctx = makeContext(session, {
			getContextUsage: () => ({ tokens: 1500, contextWindow: 10000, percent: 15 }),
		});
		const result = await tool.execute("call", { verbose: false }, undefined, undefined, ctx);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("• Context Usage:    15.0% (1.5k/10k)");
		expect(text).toContain("• Recommendation:   ok");
		expect(text).toContain(`• ${root} (ROOT, tag: task-start) [USER] root task`);
		expect(text).toContain("  :  ... (2 hidden messages) ...");
		expect(text).toContain("* ");
		expect(text).toContain("[USER] next request");
	});

	it("suppresses internal tool calls and custom messages when not verbose", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("root", 1));
		session.appendMessage(toolResult("context_log", "secret internal output", 2));
		session.appendCustomMessageEntry("context-management/prime", "hidden prime", false);
		session.appendMessage(user("head", 3));
		const result = await createContextLogTool().execute(
			"call",
			{ verbose: false },
			undefined,
			undefined,
			makeContext(session),
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).not.toContain("secret internal output");
		expect(text).not.toContain("hidden prime");
		expect(text).toContain("hidden messages");
	});

	it("renders unknown usage when unavailable", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("root"));
		const result = await createContextLogTool().execute("call", {}, undefined, undefined, makeContext(session));
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("• Context Usage:    Unknown");
	});

	it("renders open todos in dashboard", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("root", 1));
		session.appendMessage(
			todoPhasesMessage(
				[
					{
						name: "Implementation",
						tasks: [
							{ content: "finish tool wiring", status: "in_progress" },
							{ content: "run tests", status: "pending" },
						],
					},
				],
				2,
			),
		);
		const result = await createContextLogTool().execute("call", {}, undefined, undefined, makeContext(session));
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("• Open todos:       Implementation 1 in_progress, 1 pending");
		expect(result.details?.health.openTodos).toEqual([{ phase: "Implementation", pending: 1, inProgress: 1 }]);
	});
});
