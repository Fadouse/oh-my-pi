import { describe, expect, it } from "bun:test";
import { resolveTargetId } from "@oh-my-pi/pi-coding-agent/context-management/helpers";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { user } from "./test-utils";

describe("context-management helpers", () => {
	it("resolves root to the root entry id", () => {
		const session = SessionManager.inMemory();
		const rootId = session.appendMessage(user("root"));
		session.appendMessage(user("child"));
		expect(resolveTargetId(session, "root")).toBe(rootId);
	});

	it("passes through bare hex ids", () => {
		const session = SessionManager.inMemory();
		expect(resolveTargetId(session, "abcdef12")).toBe("abcdef12");
	});

	it("resolves tag names by walking the tree iteratively", () => {
		const session = SessionManager.inMemory();
		let taggedId = "";
		for (let i = 0; i < 2500; i++) {
			const id = session.appendMessage(user(`message ${i}`, i));
			if (i === 2400) taggedId = id;
		}
		session.appendLabelChange(taggedId, "deep-tag");
		expect(resolveTargetId(session, "deep-tag")).toBe(taggedId);
	});

	it("falls through unknown targets", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("root"));
		expect(resolveTargetId(session, "missing-tag")).toBe("missing-tag");
	});
});
