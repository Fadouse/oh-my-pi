import { beforeAll, describe, expect, it } from "bun:test";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BranchSummaryMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/branch-summary-message";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { BranchSummaryMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

beforeAll(async () => {
	_resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

describe("BranchSummaryMessageComponent", () => {
	it("renders ACM checkout metadata and original messages inside the checkout background", () => {
		const message: BranchSummaryMessage = {
			role: "branchSummary",
			summary: [
				"Objective: Improve ACM checkout display",
				"User Constraints: Preserve original history",
				"Current Artifact: Checkout block design",
				"Next Step: Run focused tests",
			].join("\n"),
			fromId: "root",
			timestamp: Date.now(),
			details: {
				source: "context_checkout",
				backupTag: "checkout-ui-raw",
				mode: "squash",
				range: {
					topic: "Checkout UI",
					startRef: "m0001",
					endRef: "m0002",
					entryIds: ["a", "b"],
				},
			},
			originalMessages: [
				{ role: "user", content: "Please improve checkout UI", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Reasoning summary from archived turn" },
						{ type: "text", text: "I will update the block." },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 2,
				},
			],
		};
		const component = new BranchSummaryMessageComponent(message);
		component.setExpanded(true);

		const rawLines = component.render(100);
		const customBgPrefix = theme.bg("customMessageBg", "").replace("\x1b[49m", "");
		const startLine = rawLines.find(line => line.includes("checkout original history start m0001..m0002"));
		const originalUserLine = rawLines.find(line => line.includes("Please improve checkout UI"));
		const endLine = rawLines.find(line => line.includes("checkout original history end m0001..m0002"));
		expect(startLine).toContain(customBgPrefix);
		expect(originalUserLine).toContain(customBgPrefix);
		expect(endLine).toContain(customBgPrefix);
		const rendered = Bun.stripANSI(rawLines.join("\n"));
		expect(rendered).toContain("context checkout");
		expect(rendered).toContain("m0001..m0002");
		expect(rendered).toContain("Please improve checkout UI");
		expect(rendered).toContain("I will update the block.");
		expect(rendered).toContain("Reasoning summary from archived turn");
	});
});
