import { describe, expect, it } from "bun:test";
import { injectContextRefsIntoMessages } from "@oh-my-pi/pi-coding-agent/session/context-refs";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("session context refs", () => {
	it("injects stable short refs into LLM-visible messages without mutating session messages", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		session.appendMessage({ role: "user", content: [{ type: "text", text: "second" }], timestamp: 2 });

		const context = session.buildSessionContext();
		const converted = convertToLlm(context.messages);
		const tagged = injectContextRefsIntoMessages(converted, context.messages, session.getBranch());

		expect(tagged).not.toBe(converted);
		expect(tagged[0]).toMatchObject({
			role: "user",
			content: "first\n\n<ctx>m0001</ctx>",
		});
		expect(tagged[1]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "second\n\n<ctx>m0002</ctx>" }],
		});
		expect(context.messages[0]).toMatchObject({ role: "user", content: "first" });
		expect(context.messages[1]).toMatchObject({ role: "user", content: [{ type: "text", text: "second" }] });
	});
});
