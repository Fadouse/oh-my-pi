import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createContextManagementExtensionWithSettings } from "@oh-my-pi/pi-coding-agent/context-management";
import { clearAllPendingForTests, peekPending } from "@oh-my-pi/pi-coding-agent/context-management/state";
import { createContextCheckoutTool } from "@oh-my-pi/pi-coding-agent/context-management/tools/context-checkout";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { makeApi, makeContext, user } from "./test-utils";

describe("context_checkout", () => {
	afterEach(() => {
		clearAllPendingForTests();
		vi.restoreAllMocks();
	});

	it("applies backup tag, creates branch summary, stages pending, aborts, navigates, and clears", async () => {
		const session = SessionManager.inMemory();
		const target = session.appendMessage(user("start"));
		session.appendLabelChange(target, "task-start");
		const leaf = session.appendMessage(user("work"));
		const api = makeApi(session);
		const tool = createContextCheckoutTool(api);
		const result = await tool.execute(
			"call",
			{
				target: "task-start",
				message: "Status: working\nReason: reduce context\nFiles Touched: none\nNext Step: continue.",
				backupTag: "raw-history",
			},
			undefined,
			undefined,
			makeContext(session),
		);
		const summaryEntryId = result.details?.summaryEntryId;
		expect(session.getLabel(leaf)).toBe("raw-history");
		expect(summaryEntryId).toBeString();
		const summary = session.getEntry(summaryEntryId ?? "");
		expect(summary?.type).toBe("branch_summary");
		expect(summary?.parentId).toBe(target);
		expect(peekPending(session.getSessionId())?.summaryEntryId).toBe(summaryEntryId);

		const harness = createExtensionHarness(session);
		const abort = vi.fn();
		const navigateTree = vi.fn(async () => ({ cancelled: false }));
		const notify = vi.fn();
		const ctx = makeContext(session, { abort, navigateTree, ui: { notify } as unknown as ExtensionContext["ui"] });
		await harness.emit("turn_end", ctx);
		expect(abort).toHaveBeenCalledTimes(1);
		await harness.emit("agent_end", ctx);
		expect(navigateTree).toHaveBeenCalledWith(summaryEntryId, { summarize: false });
		expect(peekPending(session.getSessionId())).toBeUndefined();
		expect(harness.sentMessages).toHaveLength(1);
	});

	it("does not stage checkout when already at target", async () => {
		const session = SessionManager.inMemory();
		const target = session.appendMessage(user("start"));
		const result = await createContextCheckoutTool(makeApi(session)).execute(
			"call",
			{ target, message: "No-op." },
			undefined,
			undefined,
			makeContext(session),
		);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toBe(`Already at target ${target}`);
		expect(peekPending(session.getSessionId())).toBeUndefined();
	});

	it("keeps pending checkout isolated by session id", async () => {
		const sessionA = SessionManager.inMemory();
		const aTarget = sessionA.appendMessage(user("a-start"));
		sessionA.appendMessage(user("a-work"));
		const sessionB = SessionManager.inMemory();
		sessionB.appendMessage(user("b-start"));
		const aResult = await createContextCheckoutTool(makeApi(sessionA)).execute(
			"call",
			{ target: aTarget, message: "Reason: isolate session\nFiles Touched: none\nNext Step: continue A." },
			undefined,
			undefined,
			makeContext(sessionA),
		);
		const harness = createExtensionHarness(sessionA);
		const navA = vi.fn(async () => ({ cancelled: false }));
		const navB = vi.fn(async () => ({ cancelled: false }));
		await harness.emit("agent_end", makeContext(sessionB, { navigateTree: navB }));
		expect(navB).not.toHaveBeenCalled();
		expect(peekPending(sessionA.getSessionId())?.summaryEntryId).toBe(aResult.details?.summaryEntryId);
		await harness.emit("agent_end", makeContext(sessionA, { navigateTree: navA }));
		expect(navA).toHaveBeenCalledWith(aResult.details?.summaryEntryId, { summarize: false });
	});

	it("rejects strict schema failures before mutating session", async () => {
		const session = SessionManager.inMemory();
		const target = session.appendMessage(user("start"));
		const leaf = session.appendMessage(user("work"));
		const tool = createContextCheckoutTool(makeApi(session));
		let error: unknown;
		try {
			await tool.execute(
				"call",
				{ target, message: "Status: missing next step", backupTag: "raw-history" },
				undefined,
				undefined,
				makeContext(session),
			);
		} catch (err) {
			error = err;
		}
		expect(error).toBeInstanceOf(Error);
		expect(error instanceof Error ? error.message : "").toContain("nextStep");
		expect(error instanceof Error ? error.message : "").toContain("Next Step:");
		expect(session.getLabel(leaf)).toBeUndefined();
		expect(peekPending(session.getSessionId())).toBeUndefined();
		expect(session.getBranch().some(entry => entry.type === "branch_summary")).toBe(false);
	});

	it("stages recover mode to a known tag without creating a summary", async () => {
		const session = SessionManager.inMemory();
		const target = session.appendMessage(user("start"));
		session.appendLabelChange(target, "task-start");
		session.appendMessage(user("work"));
		const result = await createContextCheckoutTool(makeApi(session)).execute(
			"call",
			{
				target: "task-start",
				message: "Reason: recover raw context\nFiles Touched: none\nNext Step: resume.",
				mode: "recover",
			},
			undefined,
			undefined,
			makeContext(session),
		);
		expect(result.details?.mode).toBe("recover");
		expect(session.getBranch().some(entry => entry.type === "branch_summary")).toBe(false);
		const harness = createExtensionHarness(session);
		const navigateTree = vi.fn(async () => ({ cancelled: false }));
		await harness.emit("agent_end", makeContext(session, { navigateTree }));
		expect(navigateTree).toHaveBeenCalledWith(target, { summarize: false });
	});

	it("copies open todos into branch summary details", async () => {
		const session = SessionManager.inMemory();
		const target = session.appendMessage(user("start"));
		session.appendMessage(user("work"));
		session.appendMessage({
			role: "toolResult",
			toolCallId: "call-todo",
			toolName: "todo_write",
			content: [{ type: "text", text: "updated" }],
			details: {
				phases: [{ name: "Implementation", tasks: [{ content: "finish", status: "pending" }] }],
			},
			isError: false,
			timestamp: Date.now(),
		});
		const result = await createContextCheckoutTool(makeApi(session)).execute(
			"call",
			{ target, message: "Reason: preserve todo\nFiles Touched: none\nNext Step: continue." },
			undefined,
			undefined,
			makeContext(session),
		);
		const summary = session.getEntry(result.details?.summaryEntryId ?? "");
		if (summary?.type !== "branch_summary") throw new Error("Expected branch summary");
		expect(summary.details).toMatchObject({
			source: "context_checkout",
			openTodos: [{ name: "Implementation", tasks: [{ content: "finish", status: "pending" }] }],
		});
	});
});

type EventName = "turn_end" | "agent_end" | "session_shutdown";

function createExtensionHarness(session: SessionManager) {
	const handlers = new Map<string, ExtensionHandler<unknown>[]>();
	const tools: ToolDefinition[] = [];
	const sentMessages: unknown[] = [];
	const api = {
		on: (event: string, handler: ExtensionHandler<unknown>) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		setLabel: (targetId: string, label?: string) => session.appendLabelChange(targetId, label),
		sendMessage: (message: unknown, options: unknown) => sentMessages.push({ message, options }),
	} as unknown as ExtensionAPI;
	createContextManagementExtensionWithSettings(api, Settings.isolated({ "contextManagement.enabled": true }));
	return {
		tools,
		sentMessages,
		emit: async (event: EventName, ctx: ExtensionContext) => {
			for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
		},
	};
}
