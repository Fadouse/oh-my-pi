import { describe, expect, it, vi } from "bun:test";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("ExtensionContext.navigateTree", () => {
	it("routes through the runner navigateTree handler", async () => {
		const navigateTree = vi.fn(async () => ({ cancelled: true }));
		const runner = createRunner();
		runner.initialize(createActions(), createContextActions(), {
			...createCommandActions(),
			navigateTree,
		});
		await expect(runner.createContext().navigateTree("target", { summarize: false })).resolves.toEqual({
			cancelled: true,
		});
		expect(navigateTree).toHaveBeenCalledWith("target", { summarize: false });
	});

	it("is a safe no-op without command context actions", async () => {
		const runner = createRunner();
		runner.initialize(createActions(), createContextActions());
		await expect(runner.createContext().navigateTree("target")).resolves.toEqual({ cancelled: false });
	});
});

function createRunner(): ExtensionRunner {
	return new ExtensionRunner([], new ExtensionRuntime(), process.cwd(), SessionManager.inMemory(), {} as never);
}

function createActions(): ExtensionActions {
	return {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: async () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		getSessionName: () => undefined,
		setSessionName: async () => {},
	};
}

function createContextActions(): ExtensionContextActions {
	return {
		getModel: () => undefined,
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: async () => {},
		getSystemPrompt: () => [],
	};
}

function createCommandActions(): ExtensionCommandContextActions {
	return {
		getContextUsage: () => undefined,
		waitForIdle: async () => {},
		newSession: async () => ({ cancelled: false }),
		branch: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: async () => {},
		compact: async () => {},
	};
}
