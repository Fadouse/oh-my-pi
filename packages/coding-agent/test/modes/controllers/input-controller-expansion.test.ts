import { beforeAll, describe, expect, it } from "bun:test";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BranchSummaryMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/branch-summary-message";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { BranchSummaryMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { Container } from "@oh-my-pi/pi-tui";

class ExpandableProbe {
	calls: boolean[] = [];

	setExpanded(expanded: boolean): void {
		this.calls.push(expanded);
	}

	invalidate(): void {}

	render(): string[] {
		return [];
	}
}

function branchSummary(): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary: "Objective: test\nReason: test\nUser Constraints: none\nCurrent Artifact: none\nNext Step: continue",
		fromId: "root",
		timestamp: Date.now(),
		details: {
			source: "context_checkout",
			mode: "squash",
			target: "root",
			range: { startRef: "a", endRef: "b", entryIds: ["a", "b"] },
		},
		originalMessages: [],
	};
}

function createController(
	chatContainer: Container,
	renderCalls: Array<boolean | { force?: boolean; clearScrollback?: boolean }>,
): InputController {
	return new InputController({
		toolOutputExpanded: false,
		checkoutTranscriptExpanded: false,
		chatContainer,
		ui: {
			requestRender(options?: boolean | { force?: boolean; clearScrollback?: boolean }): void {
				renderCalls.push(options ?? false);
			},
		},
	} as InteractiveModeContext);
}

beforeAll(async () => {
	_resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});
describe("InputController tool output expansion", () => {
	it("forces a full redraw after toggling historical expandable blocks", () => {
		const chatContainer = new Container();
		const expandable = new ExpandableProbe();
		chatContainer.addChild(expandable);
		const renderCalls: Array<boolean | { force?: boolean; clearScrollback?: boolean }> = [];
		const controller = createController(chatContainer, renderCalls);

		controller.setToolsExpanded(true);

		expect(expandable.calls).toEqual([true]);
		expect(renderCalls).toEqual([{ force: true, clearScrollback: false }]);
	});

	it("does not expand checkout summaries with the general tool-output shortcut", () => {
		const chatContainer = new Container();
		const checkout = new BranchSummaryMessageComponent(branchSummary());
		const calls: boolean[] = [];
		checkout.setExpanded = (expanded: boolean) => {
			calls.push(expanded);
		};
		chatContainer.addChild(checkout);
		const renderCalls: Array<boolean | { force?: boolean; clearScrollback?: boolean }> = [];
		const controller = createController(chatContainer, renderCalls);

		controller.setToolsExpanded(true);

		expect(calls).toEqual([]);
		expect(renderCalls).toEqual([{ force: true, clearScrollback: false }]);
	});

	it("expands checkout summaries with the dedicated checkout transcript shortcut", () => {
		const chatContainer = new Container();
		const checkout = new BranchSummaryMessageComponent(branchSummary());
		const calls: boolean[] = [];
		checkout.setExpanded = (expanded: boolean) => {
			calls.push(expanded);
		};
		chatContainer.addChild(checkout);
		const renderCalls: Array<boolean | { force?: boolean; clearScrollback?: boolean }> = [];
		const controller = createController(chatContainer, renderCalls);

		controller.toggleCheckoutTranscriptExpansion();

		expect(calls).toEqual([true]);
		expect(renderCalls).toEqual([{ force: true, clearScrollback: false }]);
	});

	it("forces a redraw after checkout transcript expansion changes historical height", () => {
		const chatContainer = new Container();
		const checkout = new BranchSummaryMessageComponent(branchSummary());
		chatContainer.addChild(checkout);
		const renderCalls: Array<boolean | { force?: boolean; clearScrollback?: boolean }> = [];
		const controller = createController(chatContainer, renderCalls);

		const before = Bun.stripANSI(chatContainer.render(100).join("\n"));
		controller.toggleCheckoutTranscriptExpansion();
		const after = Bun.stripANSI(chatContainer.render(100).join("\n"));

		expect(after).not.toBe(before);
		expect(after).toContain("Expanded checkout");
		expect(renderCalls).toEqual([{ force: true, clearScrollback: false }]);
	});
});
