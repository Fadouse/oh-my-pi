import { describe, expect, it } from "bun:test";
import { createContextTagTool } from "@oh-my-pi/pi-coding-agent/context-management/tools/context-tag";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { assistantText, assistantToolOnly, makeApi, makeContext, toolResult, user } from "./test-utils";

describe("context_tag", () => {
	it("attaches a label and round-trips through getLabel", async () => {
		const session = SessionManager.inMemory();
		const id = session.appendMessage(user("start"));
		const tool = createContextTagTool(makeApi(session));
		const result = await tool.execute(
			"call",
			{ name: "task-start", target: id },
			undefined,
			undefined,
			makeContext(session),
		);
		expect(session.getLabel(id)).toBe("task-start");
		const firstContent = result.content[0];
		expect(firstContent?.type).toBe("text");
		if (firstContent?.type !== "text") throw new Error("Expected text result");
		expect(firstContent.text).toBe(`Created tag 'task-start' at ${id}`);
		expect(result.details).toEqual({ id, name: "task-start" });
	});

	it("does not require extension runtime actions to create labels", async () => {
		const session = SessionManager.inMemory();
		const id = session.appendMessage(user("start"));
		const api = {
			...makeApi(session),
			setLabel: () => {
				throw new Error(
					"Extension runtime not initialized. Action methods cannot be called during extension loading.",
				);
			},
		};

		await createContextTagTool(api).execute(
			"call",
			{ name: "runtime-independent", target: id },
			undefined,
			undefined,
			makeContext(session),
		);

		expect(session.getLabel(id)).toBe("runtime-independent");
	});

	it("resolves explicit HEAD to the current leaf", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("start"));
		const head = session.appendMessage(user("current"));
		const result = await createContextTagTool(makeApi(session)).execute(
			"call",
			{ name: "head-tag", target: "HEAD" },
			undefined,
			undefined,
			makeContext(session),
		);
		expect(session.getLabel(head)).toBe("head-tag");
		expect(result.details).toEqual({ id: head, name: "head-tag" });
	});

	it("reports unresolved targets before mutating state", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("start"));
		let error: unknown;
		try {
			await createContextTagTool(makeApi(session)).execute(
				"call",
				{ name: "bad", target: "missing-target" },
				undefined,
				undefined,
				makeContext(session),
			);
		} catch (err) {
			error = err;
		}
		expect(error).toBeInstanceOf(Error);
		expect(error instanceof Error ? error.message : "").toContain("context_tag target not found");
		expect(session.getEntries().some(entry => session.getLabel(entry.id) === "bad")).toBe(false);
	});

	it("auto-resolves past internal tool-only assistant and internal tool result entries", async () => {
		const session = SessionManager.inMemory();
		const stableId = session.appendMessage(assistantText("stable work"));
		session.appendMessage(assistantToolOnly("context_log"));
		session.appendMessage(toolResult("context_log", "log output"));
		const tool = createContextTagTool(makeApi(session));
		await tool.execute("call", { name: "stable" }, undefined, undefined, makeContext(session));
		expect(session.getLabel(stableId)).toBe("stable");
		expect(session.getLabel(session.getLeafId() ?? "")).toBeUndefined();
	});

	it("rejects duplicate names without mutating state", async () => {
		const session = SessionManager.inMemory();
		const first = session.appendMessage(user("first"));
		const second = session.appendMessage(user("second"));
		session.appendLabelChange(first, "dup");
		const entriesBefore = session.getEntries().length;
		const tool = createContextTagTool(makeApi(session));
		const result = await tool.execute(
			"call",
			{ name: "dup", target: second },
			undefined,
			undefined,
			makeContext(session),
		);
		const errorContent = result.content[0];
		if (errorContent?.type !== "text") throw new Error("Expected text result");
		expect(errorContent.text).toBe(
			`Error: Tag 'dup' already exists at ${first}. Tag names must be unique. Use a different name or delete the existing tag first.`,
		);
		expect(session.getLabel(second)).toBeUndefined();
		expect(session.getEntries()).toHaveLength(entriesBefore);
	});
});
