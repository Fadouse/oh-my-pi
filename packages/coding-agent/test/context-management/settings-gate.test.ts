import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createContextManagementExtensionWithSettings } from "@oh-my-pi/pi-coding-agent/context-management";
import type { ExtensionAPI, ExtensionHandler } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { makeContext } from "./test-utils";

describe("context-management settings gate", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("does not register tools when disabled during SDK boot", async () => {
		const { session, tempDir } = await createSdkSession(false);
		tempDirs.push(tempDir);
		try {
			expect(session.getAllToolNames()).not.toContain("context_tag");
			expect(session.getAllToolNames()).not.toContain("context_log");
			expect(session.getAllToolNames()).not.toContain("context_checkout");
		} finally {
			await session.dispose();
		}
	});

	it("registers all tools when enabled during SDK boot", async () => {
		const { session, tempDir } = await createSdkSession(true);
		tempDirs.push(tempDir);
		try {
			expect(session.getAllToolNames()).toEqual(
				expect.arrayContaining(["context_tag", "context_log", "context_checkout"]),
			);
		} finally {
			await session.dispose();
		}
	});

	it("injects ACM guidance into system prompt only when enabled", async () => {
		const off = createSystemPromptHarness(false);
		expect(await off.emitBeforeAgentStart(["base prompt"])).toBeUndefined();

		const on = createSystemPromptHarness(true);
		const result = await on.emitBeforeAgentStart(["base prompt"]);
		expect(result?.systemPrompt).toHaveLength(1);
		expect(result?.systemPrompt?.[0]).toContain("base prompt");
		expect(result?.systemPrompt?.[0]).toContain("<context-management>");
		expect(result?.systemPrompt?.[0]).toContain("context_tag");
		expect(result?.systemPrompt?.[0]).toContain("context_checkout");
		expect(on.sentMessages).toHaveLength(0);
	});
});

async function createSdkSession(enabled: boolean) {
	const tempDir = path.join(os.tmpdir(), `pi-context-management-${Snowflake.next()}`);
	fs.mkdirSync(tempDir, { recursive: true });
	const result = await createAgentSession({
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "contextManagement.enabled": enabled }),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	return { session: result.session, tempDir };
}

function createSystemPromptHarness(enabled: boolean) {
	const handlers: ExtensionHandler<unknown>[] = [];
	const sentMessages: unknown[] = [];
	const api = {
		on: (event: string, handler: ExtensionHandler<unknown>) => {
			if (event === "before_agent_start") handlers.push(handler);
		},
		registerTool: () => {},
		setLabel: () => {},
		sendMessage: (message: unknown, options: unknown) => sentMessages.push({ message, options }),
	} as unknown as ExtensionAPI;
	createContextManagementExtensionWithSettings(api, Settings.isolated({ "contextManagement.enabled": enabled }));
	return {
		sentMessages,
		emitBeforeAgentStart: async (systemPrompt: string[]) => {
			let result: { systemPrompt?: string[] } | undefined;
			for (const handler of handlers) {
				const next = (await handler(
					{ type: "before_agent_start", prompt: "hello", systemPrompt },
					makeContext(SessionManager.inMemory()),
				)) as { systemPrompt?: string[] } | undefined;
				if (next?.systemPrompt) result = next;
			}
			return result;
		},
	};
}
