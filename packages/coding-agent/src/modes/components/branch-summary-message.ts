import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Box, Markdown, Spacer, Text } from "@oh-my-pi/pi-tui";
import { settings } from "../../config/settings";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import type { InteractiveModeContext } from "../../modes/types";
import type { BranchSummaryMessage } from "../../session/messages";
import { AssistantMessageComponent } from "./assistant-message";
import { BashExecutionComponent } from "./bash-execution";
import { DynamicBorder } from "./dynamic-border";
import { EvalExecutionComponent } from "./eval-execution";
import { appKey } from "./keybinding-hints";
import { ToolExecutionComponent, type ToolExecutionHandle } from "./tool-execution";
import { UserMessageComponent } from "./user-message";

type CheckoutSummaryDetails = {
	source?: string;
	backupTag?: string;
	target?: string;
	mode?: string;
	range?: {
		topic?: string;
		startId?: string;
		endId?: string;
		startRef?: string;
		endRef?: string;
		entryIds?: string[];
	};
};

/** Component that renders branch summaries, including ACM checkout summaries. */
export class BranchSummaryMessageComponent extends Box {
	#expanded = false;

	constructor(
		private readonly message: BranchSummaryMessage,
		private readonly ctx?: Pick<
			InteractiveModeContext,
			"agent" | "hideThinkingBlock" | "keybindings" | "sessionManager" | "ui"
		>,
	) {
		super(1, 1, t => theme.bg("customMessageBg", t));
		this.#updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#updateDisplay();
	}

	#updateDisplay(): void {
		this.clear();
		const details = getCheckoutDetails(this.message.details);
		if (details) {
			this.#renderCheckout(details);
			return;
		}
		this.#renderPlainBranch();
	}

	#renderPlainBranch(): void {
		const label = theme.fg("customMessageLabel", theme.bold("[branch]"));
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));
		if (this.#expanded) {
			const header = "**Branch Summary**\n\n";
			this.addChild(
				new Markdown(header + this.message.summary, 0, 0, getMarkdownTheme(), {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			this.addChild(new Text(theme.fg("customMessageText", "Branch summary (ctrl+o to expand)"), 0, 0));
		}
	}

	#renderCheckout(details: CheckoutSummaryDetails): void {
		const accent = (value: string) => theme.fg("accent", value);
		const muted = (value: string) => theme.fg("muted", value);
		const summary = parseSummary(this.message.summary);
		const range = details.range;
		const rangeText = range
			? `${range.startRef ?? shortId(range.startId)}..${range.endRef ?? shortId(range.endId)}`
			: (details.target ?? "unknown range");
		const count = range?.entryIds?.length;
		const backup = details.backupTag ? ` backup: ${details.backupTag}` : "";

		this.addChild(new DynamicBorder(text => theme.fg("accent", text)));
		this.addChild(
			new Text(
				[
					accent(theme.bold("context checkout")),
					muted(details.mode ? ` ${details.mode}` : ""),
					muted(" · "),
					accent(rangeText),
					count ? muted(` · ${count} messages`) : "",
					backup ? muted(` ·${backup}`) : "",
				].join(""),
				1,
				0,
			),
		);
		this.addChild(
			new Text(theme.fg("customMessageText", range?.topic ?? summary.objective ?? "context checkout"), 1, 0),
		);
		if (summary.nextStep) {
			this.addChild(new Text(`${muted("next ")}${theme.fg("customMessageText", summary.nextStep)}`, 1, 0));
		}
		this.addChild(
			new Text(
				muted(
					this.#expanded
						? "Expanded checkout: summary is above; original messages are between the markers below"
						: `Checkout summary (${this.#checkoutExpandKey()} to expand original messages)`,
				),
				1,
				0,
			),
		);
		if (this.#expanded) {
			this.addChild(new Spacer(1));
			this.addChild(
				new Markdown(this.message.summary, 1, 0, getMarkdownTheme(), {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
			this.#renderOriginalMessages(rangeText);
		}
		this.addChild(new DynamicBorder(text => theme.fg("accent", text)));
	}

	#checkoutExpandKey(): string {
		return this.ctx?.keybindings ? appKey(this.ctx.keybindings, "app.checkout.expand") : "ctrl+y";
	}

	#hideThinkingBlock(): boolean {
		return this.ctx?.hideThinkingBlock ?? settings.get("hideThinkingBlock");
	}

	#renderOriginalMessages(rangeText: string): void {
		const originalMessages = this.message.originalMessages ?? [];
		this.addChild(new Spacer(1));
		if (originalMessages.length === 0) {
			this.addChild(
				new Text(theme.fg("muted", "Original checkout messages are not available in this summary."), 1, 0),
			);
			return;
		}
		this.addChild(new Text(theme.fg("accent", theme.bold(`checkout original history start ${rangeText}`)), 1, 0));
		const pendingTools = new Map<string, ToolExecutionHandle>();
		for (const original of originalMessages) {
			this.#addOriginalMessage(original, pendingTools);
		}
		this.addChild(new Text(theme.fg("accent", theme.bold(`checkout original history end ${rangeText}`)), 1, 0));
	}

	#addOriginalMessage(message: AgentMessage, pendingTools: Map<string, ToolExecutionHandle>): void {
		switch (message.role) {
			case "user":
			case "developer": {
				const text = getUserText(message);
				if (text)
					this.addChild(
						new UserMessageComponent(text, message.role === "developer" ? true : (message.synthetic ?? false)),
					);
				break;
			}
			case "assistant": {
				const assistantComponent = new AssistantMessageComponent(message, this.#hideThinkingBlock());
				this.addChild(assistantComponent);
				this.#addToolCalls(message, pendingTools);
				break;
			}
			case "toolResult": {
				const component = pendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult({ content: message.content, details: message.details, isError: message.isError });
					pendingTools.delete(message.toolCallId);
				}
				break;
			}
			case "bashExecution": {
				if (!this.ctx) break;
				const component = new BashExecutionComponent(message.command, this.ctx.ui, message.excludeFromContext);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(message.exitCode, message.cancelled, { truncation: message.meta?.truncation });
				component.setExpanded(this.#expanded);
				this.addChild(component);
				break;
			}
			case "pythonExecution": {
				if (!this.ctx) break;
				const component = new EvalExecutionComponent(message.code, this.ctx.ui, message.excludeFromContext);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(message.exitCode, message.cancelled, { truncation: message.meta?.truncation });
				component.setExpanded(this.#expanded);
				this.addChild(component);
				break;
			}
			case "custom":
			case "hookMessage":
			case "fileMention":
			case "branchSummary":
			case "compactionSummary":
				this.addChild(new Text(theme.fg("muted", `[${message.role}]`), 1, 0));
				break;
		}
	}

	#addToolCalls(message: AssistantMessage, pendingTools: Map<string, ToolExecutionHandle>): void {
		if (!this.ctx) return;
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			const tool = this.ctx.agent.state.tools.find(candidate => candidate.name === content.name);
			const component = new ToolExecutionComponent(
				content.name,
				content.arguments,
				{},
				tool,
				this.ctx.ui,
				this.ctx.sessionManager.getCwd(),
				content.id,
			);
			component.setArgsComplete(content.id);
			component.setExpanded(this.#expanded);
			this.addChild(component);
			pendingTools.set(content.id, component);
		}
	}
}

function getCheckoutDetails(details: unknown): CheckoutSummaryDetails | undefined {
	if (!details || typeof details !== "object") return undefined;
	const record = details as CheckoutSummaryDetails;
	return record.source === "context_checkout" ? record : undefined;
}

function parseSummary(summary: string): { objective?: string; nextStep?: string } {
	return {
		objective: parseField(summary, "Objective"),
		nextStep: parseField(summary, "Next Step"),
	};
}

function parseField(summary: string, name: string): string | undefined {
	const regex = new RegExp(`(?:^|\\n)${name}:\\s*(.+)`);
	return summary.match(regex)?.[1]?.trim();
}

function getUserText(message: Extract<AgentMessage, { role: "user" | "developer" }>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map(part => part.text)
		.join("");
}

function shortId(id: string | undefined): string {
	if (!id) return "?";
	return id.length > 8 ? id.slice(0, 8) : id;
}
