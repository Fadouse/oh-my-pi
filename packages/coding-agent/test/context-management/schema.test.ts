import { describe, expect, it } from "bun:test";
import { parseCheckoutMessage, validateCheckoutSchema } from "@oh-my-pi/pi-coding-agent/context-management/schema";

describe("checkout message schema", () => {
	it("recognizes colon, bold-colon, and markdown headers", () => {
		const parsed = parseCheckoutMessage(
			[
				"Status: working",
				"**Reason**: context is noisy",
				"### Files Touched",
				"packages/coding-agent/src/context-management/schema.ts",
				"### Next Step",
				"Run tests",
			].join("\n"),
		);
		expect(parsed.status).toBe("working");
		expect(parsed.reason).toBe("context is noisy");
		expect(parsed.filesTouched).toContain("schema.ts");
		expect(parsed.nextStep).toBe("Run tests");
	});

	it("enforces required fields in strict mode", () => {
		const parsed = parseCheckoutMessage("Status: work preserved");
		const result = validateCheckoutSchema(parsed, { strict: true });
		expect(result.ok).toBe(false);
		expect(result.missing).toEqual(["reason", "nextStep", "importantChangesOrFilesTouched"]);
		expect(result.template).toContain("Reason:");
		expect(result.template).toContain("Next Step:");
		expect(result.template).toContain("Important Changes:");
		expect(result.template).toContain("Files Touched:");
	});

	it("accepts Important Changes instead of Files Touched", () => {
		const parsed = parseCheckoutMessage(
			["Reason: reduce context", "Important Changes: implemented schema", "Next Step: continue"].join("\n"),
		);
		expect(validateCheckoutSchema(parsed, { strict: true }).ok).toBe(true);
	});

	it("does not reject in non-strict mode", () => {
		const parsed = parseCheckoutMessage("Status: partial");
		const result = validateCheckoutSchema(parsed, { strict: false });
		expect(result.ok).toBe(true);
		expect(result.missing).toEqual([]);
	});
});
