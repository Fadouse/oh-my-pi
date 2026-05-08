import { describe, expect, it } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
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

describe("InputController tool output expansion", () => {
	it("forces a full redraw after toggling historical expandable blocks", () => {
		const chatContainer = new Container();
		const expandable = new ExpandableProbe();
		chatContainer.addChild(expandable);
		const renderCalls: boolean[] = [];
		const controller = new InputController({
			toolOutputExpanded: false,
			chatContainer,
			ui: {
				requestRender(force?: boolean): void {
					renderCalls.push(force ?? false);
				},
			},
		} as InteractiveModeContext);

		controller.setToolsExpanded(true);

		expect(expandable.calls).toEqual([true]);
		expect(renderCalls).toEqual([true]);
	});
});
