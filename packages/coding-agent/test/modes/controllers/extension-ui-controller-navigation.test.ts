import { describe, expect, it, vi } from "bun:test";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

describe("ExtensionUiController navigation rendering", () => {
	it("forces a viewport redraw after tree navigation rebuilds the transcript", async () => {
		let navigateTree:
			| ((targetId: string, options?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>)
			| undefined;
		const sessionContext = { messages: [] } as never;
		const renderInitialMessages = vi.fn();
		const requestRender = vi.fn();
		const ctx = {
			isBackgrounded: false,
			session: {
				extensionRunner: {
					initialize: (
						_actions: unknown,
						_contextActions: unknown,
						commandActions: { navigateTree: typeof navigateTree },
					) => {
						navigateTree = commandActions.navigateTree;
					},
				},
				isStreaming: false,
				queuedMessageCount: 0,
				model: undefined,
				systemPrompt: [],
				agent: { waitForIdle: vi.fn() },
				abort: vi.fn(),
				getContextUsage: vi.fn(),
				navigateTree: vi.fn(async () => ({ cancelled: false, sessionContext })),
			},
			chatContainer: { clear: vi.fn() },
			renderInitialMessages,
			reloadTodos: vi.fn(async () => {}),
			editor: { getText: vi.fn(() => ""), setText: vi.fn() },
			showStatus: vi.fn(),
			ui: { requestRender },
			setWorkingMessage: vi.fn(),
			sessionManager: { getSessionName: vi.fn(), getCwd: vi.fn(() => process.cwd()) },
		} as unknown as InteractiveModeContext;
		const controller = new ExtensionUiController(ctx);

		controller.initializeHookRunner({} as never, true);
		await navigateTree?.("target", { summarize: false });

		expect(ctx.session.navigateTree).toHaveBeenCalledWith("target", { summarize: false });
		expect(renderInitialMessages).toHaveBeenCalledWith(sessionContext);
		expect(requestRender).toHaveBeenCalledWith({ force: true, clearScrollback: false });
	});
});
