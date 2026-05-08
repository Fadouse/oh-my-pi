import { describe, expect, it } from "bun:test";
import {
	type ContextSearchExtractor,
	collectSearchDocuments,
	createContextSearchTool,
	searchDocuments,
} from "@oh-my-pi/pi-coding-agent/context-management/tools/context-search";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { assistantText, makeContext, user } from "./test-utils";

class FakeExtractor implements ContextSearchExtractor {
	queries: string[] = [];
	candidateIds: string[][] = [];

	async extract(input: Parameters<ContextSearchExtractor["extract"]>[0]) {
		this.queries.push(input.query);
		this.candidateIds.push(input.candidates.map(candidate => candidate.id));
		return {
			answer: `found ${input.candidates[0]?.id ?? "none"}`,
			confidence: "high" as const,
			citations: input.candidates.slice(0, 1).map(candidate => candidate.id),
		};
	}
}

describe("context_search", () => {
	it("retrieves relevant history and delegates answer extraction", async () => {
		const session = SessionManager.inMemory();
		const root = session.appendMessage(user("Investigate deployment regression", 1));
		session.appendLabelChange(root, "deploy-regression-start");
		const answerId = session.appendMessage(
			assistantText("Root cause: API token rotated without updating CI secret", 2),
		);
		session.appendMessage(user("unrelated follow-up", 3));
		const extractor = new FakeExtractor();

		const result = await createContextSearchTool(undefined, extractor).execute(
			"call",
			{ query: "what was the CI secret root cause", limit: 3 },
			undefined,
			undefined,
			makeContext(session),
		);

		expect(result.details?.candidates.map(candidate => candidate.id)).toContain(answerId);
		expect(extractor.queries).toEqual(["what was the CI secret root cause"]);
		expect(extractor.candidateIds[0]).toContain(answerId);
		expect(result.details?.answer).toMatchObject({ confidence: "high" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("[Context Search]");
		expect(text).toContain("Answer:");
	});

	it("supports current_tree scope for off-branch entries", async () => {
		const session = SessionManager.inMemory();
		const root = session.appendMessage(user("root", 1));
		const branchPoint = session.appendMessage(assistantText("branch point", 2));
		session.branch(branchPoint);
		const abandoned = session.appendMessage(user("lost context mentions polar clocks", 3));
		session.branch(branchPoint);
		session.appendMessage(user("current branch only", 4));

		const branchDocuments = collectSearchDocuments(makeContext(session), "current_branch");
		const treeDocuments = collectSearchDocuments(makeContext(session), "current_tree");
		const branchCandidates = searchDocuments(branchDocuments, "polar clocks", 5, 1200);
		const treeCandidates = searchDocuments(treeDocuments, "polar clocks", 5, 1200);

		expect(branchCandidates.map(candidate => candidate.id)).not.toContain(abandoned);
		expect(treeCandidates.map(candidate => candidate.id)).toContain(abandoned);
		expect(treeDocuments.map(document => document.id)).toContain(root);
	});

	it("returns a truthful no-match result without invoking extractor", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("only alpha beta", 1));
		const extractor = new FakeExtractor();

		const result = await createContextSearchTool(undefined, extractor).execute(
			"call",
			{ query: "zzzzzzzz-no-such-history", extractAnswer: true },
			undefined,
			undefined,
			makeContext(session),
		);

		expect(result.details?.candidateCount).toBe(0);
		expect(result.details?.candidates).toEqual([]);
		expect(extractor.queries).toEqual([]);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("No matching conversation history found");
	});
});
