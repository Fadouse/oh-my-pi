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
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo-write";
import { makeApi, makeContext, todoPhasesMessage, user } from "./test-utils";

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
				message:
					"Objective: test checkout\nStatus: working\nReason: reduce context\nFiles Touched: none\nUser Constraints: none\nCurrent Artifact: none\nNext Step: continue.",
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
		expect(notify).toHaveBeenCalledTimes(1);
		const notification = notify.mock.calls[0]?.[0];
		expect(notification).toContain("Summary block added to transcript.");
		expect(notification).not.toContain("Objective:");
		expect(notification).not.toContain("Next Step:");
		expect(peekPending(session.getSessionId())).toBeUndefined();
		expect(harness.sentMessages).toHaveLength(1);
	});

	it("stages range checkout from model-selected start and end boundaries", async () => {
		const session = SessionManager.inMemory();
		const before = session.appendMessage(user("keep before"));
		session.appendLabelChange(before, "range-anchor");
		const anchor = session.getLeafId();
		const start = session.appendMessage(user("range start"));
		const end = session.appendMessage(user("range end"));
		const result = await createContextCheckoutTool(makeApi(session)).execute(
			"call",
			{
				startId: start,
				endId: end,
				topic: "Range Test",
				message:
					"Objective: archive completed range\nReason: completed range\nFiles Touched: none\nUser Constraints: none\nCurrent Artifact: none\nNext Step: continue.",
				backupTag: "range-raw",
			},
			undefined,
			undefined,
			makeContext(session),
		);

		const summary = session.getEntry(result.details?.summaryEntryId ?? "");
		expect(session.getLabel(end)).toBe("range-raw");
		expect(summary?.type).toBe("branch_summary");
		expect(summary?.parentId).toBe(anchor);
		expect(result.details?.range).toMatchObject({
			topic: "Range Test",
			startId: start,
			endId: end,
			startRef: start,
			endRef: end,
			parentId: anchor,
			anchorTagId: before,
			anchorTagName: "range-anchor",
			entryIds: [start, end],
		});
		expect(peekPending(session.getSessionId())?.summaryEntryId).toBe(result.details?.summaryEntryId);
	});

	it("rejects range checkout when start is not anchored after a tag", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("untagged before"));
		const start = session.appendMessage(user("range start"));
		const end = session.appendMessage(user("range end"));
		let error: unknown;

		try {
			await createContextCheckoutTool(makeApi(session)).execute(
				"call",
				{
					startId: start,
					endId: end,
					message:
						"Objective: archive completed range\nReason: completed range\nFiles Touched: none\nUser Constraints: none\nCurrent Artifact: none\nNext Step: continue.",
				},
				undefined,
				undefined,
				makeContext(session),
			);
		} catch (err) {
			error = err;
		}

		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toContain("must be immediately after a tagged checkpoint");
	});

	it("allows explicitly unsafe untagged range checkout and records that fact", async () => {
		const session = SessionManager.inMemory();
		const before = session.appendMessage(user("untagged before"));
		const start = session.appendMessage(user("range start"));
		const end = session.appendMessage(user("range end"));

		const result = await createContextCheckoutTool(makeApi(session)).execute(
			"call",
			{
				startId: start,
				endId: end,
				allowUntaggedStart: true,
				message:
					"Objective: archive completed range\nReason: completed range\nFiles Touched: none\nUser Constraints: none\nCurrent Artifact: none\nNext Step: continue.",
			},
			undefined,
			undefined,
			makeContext(session),
		);

		expect(session.getEntry(result.details?.summaryEntryId ?? "")?.parentId).toBe(before);
		expect(result.details?.range).toMatchObject({
			startId: start,
			endId: end,
			parentId: before,
			untaggedStartAllowed: true,
		});
	});

	it("ignores blank target when range boundaries are provided", async () => {
		const session = SessionManager.inMemory();
		const before = session.appendMessage(user("keep before"));
		session.appendLabelChange(before, "blank-range-anchor");
		const anchor = session.getLeafId();
		const start = session.appendMessage(user("range start"));
		const end = session.appendMessage(user("range end"));
		const result = await createContextCheckoutTool(makeApi(session)).execute(
			"call",
			{
				target: "   ",
				startId: start,
				endId: end,
				topic: "   ",
				message:
					"Objective: archive completed range\nReason: completed range\nFiles Touched: none\nUser Constraints: none\nCurrent Artifact: none\nNext Step: continue.",
				backupTag: "   ",
			},
			undefined,
			undefined,
			makeContext(session),
		);

		const summary = session.getEntry(result.details?.summaryEntryId ?? "");
		expect(summary?.type).toBe("branch_summary");
		expect(summary?.parentId).toBe(anchor);
		expect(session.getLabel(end)).toBeUndefined();
		expect(result.details?.backupTagApplied).toBeUndefined();
		expect(result.details?.range).toMatchObject({
			startId: start,
			endId: end,
			parentId: anchor,
			entryIds: [start, end],
		});
		expect(result.details?.range?.topic).toBeUndefined();
	});

	it("ignores blank range params when legacy target is provided", async () => {
		const session = SessionManager.inMemory();
		const target = session.appendMessage(user("start"));
		session.appendLabelChange(target, "legacy-start");
		const leaf = session.appendMessage(user("work"));
		const result = await createContextCheckoutTool(makeApi(session)).execute(
			"call",
			{
				target: "legacy-start",
				startId: "",
				endId: "   ",
				message:
					"Objective: legacy checkout\nReason: reduce context\nFiles Touched: none\nUser Constraints: none\nCurrent Artifact: none\nNext Step: continue.",
			},
			undefined,
			undefined,
			makeContext(session),
		);

		const summary = session.getEntry(result.details?.summaryEntryId ?? "");
		expect(summary?.type).toBe("branch_summary");
		expect(summary?.parentId).toBe(target);
		expect(result.details?.targetId).toBe(target);
		expect(result.details?.range).toBeUndefined();
		expect(session.getLeafId()).not.toBe(leaf);
	});

	it("preserves suffix entries when range end is not current HEAD", async () => {
		const session = SessionManager.inMemory();
		const before = session.appendMessage(user("keep before"));
		session.appendLabelChange(before, "suffix-anchor");
		const anchor = session.getLeafId();
		const start = session.appendMessage(user("range start"));
		const end = session.appendMessage(user("range end"));
		const suffix = session.appendMessage(user("later message"));

		const result = await createContextCheckoutTool(makeApi(session)).execute(
			"call",
			{
				startId: start,
				endId: end,
				message:
					"Objective: archive completed range\nReason: completed range\nFiles Touched: none\nUser Constraints: none\nCurrent Artifact: none\nNext Step: continue.",
			},
			undefined,
			undefined,
			makeContext(session),
		);

		const summary = session.getEntry(result.details?.summaryEntryId ?? "");
		expect(summary?.type).toBe("branch_summary");
		expect(summary?.parentId).toBe(anchor);
		expect(result.details?.range?.entryIds).toEqual([start, end]);
		expect(result.details?.range?.suffixEntryIds).toEqual([suffix]);
		const branch = session.getBranch();
		const replayedSuffixIds = result.details?.range?.replayedSuffixEntryIds ?? [];
		expect(replayedSuffixIds).toHaveLength(1);
		expect(branch.map(entry => entry.id)).toContain(result.details?.summaryEntryId ?? "");
		expect(branch.map(entry => entry.id)).not.toContain(start);
		expect(branch.map(entry => entry.id)).not.toContain(end);
		const lastEntry = branch.at(-1);
		expect(lastEntry?.type).toBe("message");
		if (lastEntry?.type !== "message") throw new Error("Expected replayed suffix message");
		expect(lastEntry.message).toMatchObject({ role: "user", content: "later message" });
		expect(peekPending(session.getSessionId())?.navigateTargetId).toBe(replayedSuffixIds[0]);
		const context = session.buildSessionContext();
		const summaryMessage = context.messages.find(message => message.role === "branchSummary");
		expect(summaryMessage).toMatchObject({
			role: "branchSummary",
			originalMessages: [
				{ role: "user", content: "range start" },
				{ role: "user", content: "range end" },
			],
		});
		expect(context.messages.map(message => (message.role === "user" ? message.content : message.role))).toEqual([
			"keep before",
			"branchSummary",
			"later message",
		]);
	});

	it("restores live todos from checkout summary details", async () => {
		const phases = [{ name: "Implementation", tasks: [{ content: "finish checkout", status: "pending" as const }] }];
		const session = SessionManager.inMemory();
		const before = session.appendMessage(user("keep before"));
		session.appendLabelChange(before, "todo-anchor");
		const anchor = session.getLeafId();
		const start = session.appendMessage(user("range start"));
		const todo = session.appendMessage(todoPhasesMessage(phases));

		const result = await createContextCheckoutTool(makeApi(session)).execute(
			"call",
			{
				startId: start,
				endId: todo,
				message:
					"Objective: archive completed range\nReason: completed range\nFiles Touched: none\nUser Constraints: none\nCurrent Artifact: none\nOpen Tasks: Implementation finish checkout pending\nNext Step: continue.",
			},
			undefined,
			undefined,
			makeContext(session),
		);

		const summary = session.getEntry(result.details?.summaryEntryId ?? "");
		expect(summary?.type).toBe("branch_summary");
		expect(summary?.parentId).toBe(anchor);
		expect(result.details?.openTodos).toEqual(phases);
		expect(getLatestTodoPhasesFromEntries(session.getBranch())).toEqual(phases);
	});

	it("reports missing checkout mode when all boundaries are blank", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("start"));
		let error: unknown;

		try {
			await createContextCheckoutTool(makeApi(session)).execute(
				"call",
				{
					target: "",
					startId: " ",
					endId: "",
					message:
						"Objective: missing checkout\nReason: test\nFiles Touched: none\nUser Constraints: none\nCurrent Artifact: none\nNext Step: continue.",
				},
				undefined,
				undefined,
				makeContext(session),
			);
		} catch (err) {
			error = err;
		}

		expect(error).toBeInstanceOf(Error);
		expect(error instanceof Error ? error.message : "").toContain("requires either target or both startId and endId");
		expect(session.getBranch().some(entry => entry.type === "branch_summary")).toBe(false);
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

	it("reports unresolved checkout targets before creating a summary", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("start"));
		let error: unknown;
		try {
			await createContextCheckoutTool(makeApi(session)).execute(
				"call",
				{ target: "missing-target", message: "Reason: test\nFiles Touched: none\nNext Step: continue." },
				undefined,
				undefined,
				makeContext(session),
			);
		} catch (err) {
			error = err;
		}
		expect(error).toBeInstanceOf(Error);
		expect(error instanceof Error ? error.message : "").toContain("context_checkout target not found");
		expect(session.getBranch().some(entry => entry.type === "branch_summary")).toBe(false);
	});

	it("keeps pending checkout isolated by session id", async () => {
		const sessionA = SessionManager.inMemory();
		const aTarget = sessionA.appendMessage(user("a-start"));
		sessionA.appendMessage(user("a-work"));
		const sessionB = SessionManager.inMemory();
		sessionB.appendMessage(user("b-start"));
		const aResult = await createContextCheckoutTool(makeApi(sessionA)).execute(
			"call",
			{
				target: aTarget,
				message:
					"Objective: isolate\nReason: isolate session\nFiles Touched: none\nUser Constraints: none\nCurrent Artifact: none\nNext Step: continue A.",
			},
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

	it("clears stale pending checkout when a later checkout attempt fails validation", async () => {
		const session = SessionManager.inMemory();
		const target = session.appendMessage(user("start"));
		const leaf = session.appendMessage(user("work"));
		const tool = createContextCheckoutTool(makeApi(session));
		const staged = await tool.execute(
			"call",
			{
				target,
				message:
					"Objective: staged\nReason: staged\nFiles Touched: none\nUser Constraints: none\nCurrent Artifact: none\nNext Step: continue.",
			},
			undefined,
			undefined,
			makeContext(session),
		);
		expect(peekPending(session.getSessionId())?.summaryEntryId).toBe(staged.details?.summaryEntryId);

		let error: unknown;
		try {
			await tool.execute(
				"call",
				{ target, message: "Status: missing required fields", backupTag: "should-not-exist" },
				undefined,
				undefined,
				makeContext(session),
			);
		} catch (err) {
			error = err;
		}

		expect(error).toBeInstanceOf(Error);
		expect(peekPending(session.getSessionId())).toBeUndefined();
		expect(session.getLabel(leaf)).toBeUndefined();
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
				message:
					"Objective: recover\nReason: recover raw context\nFiles Touched: none\nUser Constraints: none\nCurrent Artifact: none\nNext Step: resume.",
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
			{
				target,
				message:
					"Objective: preserve todos\nReason: preserve todo\nFiles Touched: none\nUser Constraints: none\nCurrent Artifact: none\nNext Step: continue.",
			},
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
