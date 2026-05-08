export interface ParsedCheckoutMessage {
	status?: string;
	reason?: string;
	importantChanges?: string;
	filesTouched?: string;
	decisions?: string;
	failedAttempts?: string;
	userConstraints?: string;
	verification?: string;
	openTasks?: string;
	doNotForget?: string;
	nextStep?: string;
	recoveryTag?: string;
	raw: string;
}

export interface SchemaValidationResult {
	ok: boolean;
	missing: string[];
	template: string;
}

type SectionKey = Exclude<keyof ParsedCheckoutMessage, "raw">;

const SECTION_NAMES: Record<SectionKey, string> = {
	status: "Status",
	reason: "Reason",
	importantChanges: "Important Changes",
	filesTouched: "Files Touched",
	decisions: "Decisions",
	failedAttempts: "Failed Attempts",
	userConstraints: "User Constraints",
	verification: "Verification",
	openTasks: "Open Tasks",
	doNotForget: "Do Not Forget",
	nextStep: "Next Step",
	recoveryTag: "Recovery Tag",
};

const NORMALIZED_TO_KEY = new Map<string, SectionKey>(
	(Object.entries(SECTION_NAMES) as [SectionKey, string][]).map(([key, value]) => [normalizeHeading(value), key]),
);

export const CHECKOUT_MESSAGE_TEMPLATE = [
	"Status: <current state>",
	"Reason: <why this checkout/squash/recovery is needed>",
	"Important Changes: <behavioral or context changes to preserve>",
	"Files Touched: <files changed or relevant, or 'none'>",
	"Decisions: <decisions made, or 'none'>",
	"Failed Attempts: <failed approaches and errors, or 'none'>",
	"User Constraints: <explicit user/repo constraints to preserve>",
	"Verification: <commands/scenarios run and results, or 'not run'>",
	"Open Tasks: <remaining todo phases/tasks, or 'none'>",
	"Do Not Forget: <critical caveats, or 'none'>",
	"Next Step: <exact next action after checkout>",
	"Recovery Tag: <backup tag to recover raw context, if any>",
].join("\n");

export function parseCheckoutMessage(message: string): ParsedCheckoutMessage {
	const parsed: ParsedCheckoutMessage = { raw: message };
	const lines = message.split(/\r?\n/);
	let activeKey: SectionKey | undefined;
	const buffers = new Map<SectionKey, string[]>();

	for (const rawLine of lines) {
		const match = parseHeaderLine(rawLine);
		if (match) {
			activeKey = match.key;
			const buffer = buffers.get(activeKey) ?? [];
			if (match.inlineValue.trim()) buffer.push(match.inlineValue.trim());
			buffers.set(activeKey, buffer);
			continue;
		}
		if (activeKey) buffers.get(activeKey)?.push(rawLine);
	}

	for (const [key, buffer] of buffers) {
		const value = buffer.join("\n").trim();
		if (value.length > 0) parsed[key] = value;
	}
	return parsed;
}

export function validateCheckoutSchema(
	parsed: ParsedCheckoutMessage,
	opts: { strict: boolean },
): SchemaValidationResult {
	const missing: string[] = [];
	if (opts.strict) {
		if (!hasValue(parsed.reason)) missing.push("reason");
		if (!hasValue(parsed.nextStep)) missing.push("nextStep");
		if (!hasValue(parsed.importantChanges) && !hasValue(parsed.filesTouched)) {
			missing.push("importantChangesOrFilesTouched");
		}
	}
	return { ok: missing.length === 0, missing, template: CHECKOUT_MESSAGE_TEMPLATE };
}

function parseHeaderLine(line: string): { key: SectionKey; inlineValue: string } | undefined {
	const stripped = line
		.trim()
		.replace(/^[-*+]\s+/, "")
		.replace(/^#{1,6}\s+/, "")
		.trim();
	const colonMatch = stripped.match(/^\*{0,2}([A-Za-z][A-Za-z\s]+?)\*{0,2}\s*:\s*(.*)$/);
	if (colonMatch) {
		const key = NORMALIZED_TO_KEY.get(normalizeHeading(colonMatch[1]));
		if (key) return { key, inlineValue: colonMatch[2] ?? "" };
	}
	const headerKey = NORMALIZED_TO_KEY.get(normalizeHeading(stripped.replace(/\*\*/g, "")));
	if (headerKey) return { key: headerKey, inlineValue: "" };
	return undefined;
}

function normalizeHeading(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hasValue(value: string | undefined): boolean {
	return value !== undefined && value.trim().length > 0;
}
