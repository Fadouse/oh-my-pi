import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import { Settings } from "../../config/settings";
import type { ExtensionContext, ToolDefinition } from "../../extensibility/extensions";
import { discoverAuthStorage } from "../../sdk";
import type { SessionEntry, SessionTreeNode } from "../../session/session-manager";
import { runSubprocess } from "../../task/executor";
import type { AgentDefinition } from "../../task/types";
import { entryRole, getMessagePreview, normalizePreview } from "../helpers";
import extractorSystemPrompt from "../prompts/search-extractor-system.md" with { type: "text" };
import extractorTaskPrompt from "../prompts/search-extractor-task.md" with { type: "text" };

const DEFAULT_LIMIT = 8;
const DEFAULT_CONTEXT_CHARS = 1_200;
const MAX_LIMIT = 20;
const MAX_CONTEXT_CHARS = 4_000;
const EXACT_MATCH_BOOST = 3;
const MIN_SCORE = 0.05;

export const contextSearchSchema = Type.Object({
	query: Type.String({ description: "Question or search text to recover from this conversation's ACM history." }),
	limit: Type.Optional(Type.Number({ description: "Maximum retrieved context candidates (default: 8, max: 20)." })),
	scope: Type.Optional(
		Type.Union([Type.Literal("current_branch"), Type.Literal("current_tree")], {
			description:
				"Search only the current HEAD-to-root branch (default), or every entry in the current session tree.",
		}),
	),
	maxContextChars: Type.Optional(
		Type.Number({ description: "Maximum characters per candidate excerpt (default: 1200, max: 4000)." }),
	),
	extractAnswer: Type.Optional(
		Type.Boolean({
			description: "Use a small subagent to extract a direct answer from retrieved excerpts (default: true).",
		}),
	),
});

export interface ContextSearchCandidate {
	id: string;
	type: string;
	role: string;
	label?: string;
	timestamp: string;
	score: number;
	text: string;
	preview: string;
}

export interface ContextSearchAnswer {
	answer: string;
	confidence: "low" | "medium" | "high";
	citations: string[];
}

export interface ContextSearchDetails {
	query: string;
	scope: "current_branch" | "current_tree";
	candidateCount: number;
	answer?: ContextSearchAnswer;
	extractionError?: string;
	candidates: ContextSearchCandidate[];
}

interface SearchDocument {
	entry: SessionEntry;
	id: string;
	type: string;
	role: string;
	label?: string;
	timestamp: string;
	text: string;
	weightedText: string;
	tokens: string[];
	trigrams: string[];
}

interface ScoredDocument {
	document: SearchDocument;
	score: number;
}

export interface ContextSearchExtractor {
	extract(input: {
		query: string;
		candidates: ContextSearchCandidate[];
		ctx: ExtensionContext;
		signal?: AbortSignal;
	}): Promise<ContextSearchAnswer>;
}

export function createContextSearchTool(
	configuredSettings?: Settings,
	extractor: ContextSearchExtractor = new SubagentContextSearchExtractor(configuredSettings),
): ToolDefinition<typeof contextSearchSchema, ContextSearchDetails> {
	return {
		name: "context_search",
		label: "Context Search",
		description:
			"Search ACM conversation history with hybrid RAG-style retrieval, then optionally ask a small subagent to extract the answer from retrieved context.",
		parameters: contextSearchSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const query = params.query.trim();
			if (!query) {
				return {
					content: [{ type: "text", text: "context_search query is empty." }],
					details: {
						query,
						scope: params.scope ?? "current_branch",
						candidateCount: 0,
						candidates: [],
					},
				};
			}

			const scope = params.scope ?? "current_branch";
			const limit = clampInteger(params.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
			const maxContextChars = clampInteger(params.maxContextChars ?? DEFAULT_CONTEXT_CHARS, 200, MAX_CONTEXT_CHARS);
			const documents = collectSearchDocuments(ctx, scope);
			const candidates = searchDocuments(documents, query, limit, maxContextChars);
			let answer: ContextSearchAnswer | undefined;
			let extractionError: string | undefined;

			if ((params.extractAnswer ?? true) && candidates.length > 0) {
				try {
					answer = await extractor.extract({ query, candidates, ctx, signal });
				} catch (error) {
					extractionError = error instanceof Error ? error.message : String(error);
				}
			}

			const details: ContextSearchDetails = {
				query,
				scope,
				candidateCount: candidates.length,
				...(answer ? { answer } : {}),
				...(extractionError ? { extractionError } : {}),
				candidates,
			};

			return {
				content: [{ type: "text", text: renderContextSearchResult(details) }],
				details,
			};
		},
	};
}

export function collectSearchDocuments(
	ctx: Pick<ExtensionContext, "sessionManager">,
	scope: "current_branch" | "current_tree",
): SearchDocument[] {
	const sm = ctx.sessionManager;
	const entries = scope === "current_branch" ? sm.getBranch() : flattenTree(sm.getTree());
	return entries
		.map(entry => {
			const label = sm.getLabel(entry.id);
			const role = entryRole(entry);
			const preview = getMessagePreview(entry, sm, true);
			const textParts = [entry.id, entry.type, role, label, preview].filter((part): part is string => Boolean(part));
			const text = textParts.join("\n");
			const weightedText = [label, label, label, entry.id, entry.type, role, preview].filter(Boolean).join(" ");
			return {
				entry,
				id: entry.id,
				type: entry.type,
				role,
				...(label ? { label } : {}),
				timestamp: entry.timestamp,
				text,
				weightedText,
				tokens: tokenize(weightedText),
				trigrams: trigrams(normalizeForSearch(weightedText)),
			};
		})
		.filter(document => document.text.trim().length > 0);
}

export function searchDocuments(
	documents: SearchDocument[],
	query: string,
	limit: number,
	maxContextChars: number,
): ContextSearchCandidate[] {
	const queryTokens = tokenize(query);
	const normalizedQuery = normalizeForSearch(query);
	const queryTrigrams = trigrams(normalizedQuery);
	if (queryTokens.length === 0 && queryTrigrams.length === 0) return [];

	const documentFrequencies = buildDocumentFrequencies(documents);
	const averageLength =
		documents.reduce((sum, document) => sum + document.tokens.length, 0) / Math.max(documents.length, 1);
	return documents
		.map(document => {
			const lexicalScore = bm25(document, queryTokens, documentFrequencies, documents.length, averageLength);
			const fuzzyScore = diceCoefficient(queryTrigrams, document.trigrams);
			const vectorScore = cosineSimilarity(queryTokens, document.tokens);
			const exactBoost = normalizeForSearch(document.weightedText).includes(normalizedQuery) ? EXACT_MATCH_BOOST : 0;
			return { document, score: lexicalScore + fuzzyScore + vectorScore + exactBoost };
		})
		.filter(result => result.score >= MIN_SCORE)
		.sort(compareScoredDocuments)
		.slice(0, limit)
		.map(result => toCandidate(result, maxContextChars));
}

class SubagentContextSearchExtractor implements ContextSearchExtractor {
	#settings: Settings;

	constructor(configuredSettings?: Settings) {
		this.#settings = configuredSettings ?? Settings.isolated({ "contextManagement.enabled": true });
	}

	async extract(input: {
		query: string;
		candidates: ContextSearchCandidate[];
		ctx: ExtensionContext;
		signal?: AbortSignal;
	}): Promise<ContextSearchAnswer> {
		const authStorage = await discoverAuthStorage();
		const result = await runSubprocess({
			cwd: input.ctx.cwd,
			agent: createExtractorAgent(),
			task: prompt.render(extractorTaskPrompt, {
				query: input.query,
				candidates: input.candidates,
			}),
			index: 0,
			id: "context-search-extractor",
			modelOverride: ["pi/smol"],
			thinkingLevel: ThinkingLevel.Minimal,
			outputSchema: answerSchema,
			signal: input.signal,
			modelRegistry: input.ctx.modelRegistry,
			settings: this.#settings,
			authStorage,
		});
		if (result.error) throw new Error(result.error);
		const data = parseExtractorOutput(result.output);
		if (!isContextSearchAnswer(data)) {
			throw new Error("context_search extractor did not return a valid answer payload");
		}
		return data;
	}
}

const answerSchema = {
	properties: {
		answer: { type: "string" },
		confidence: { enum: ["low", "medium", "high"] },
		citations: { elements: { type: "string" } },
	},
	optionalProperties: {},
} as const;

function createExtractorAgent(): AgentDefinition {
	return {
		name: "context-search-extractor",
		description: "Extracts answers from retrieved ACM history excerpts",
		systemPrompt: extractorSystemPrompt,
		tools: [],
		model: ["pi/smol"],
		thinkingLevel: ThinkingLevel.Minimal,
		output: answerSchema,
		source: "bundled",
	};
}

function parseExtractorOutput(output: string): unknown {
	try {
		return JSON.parse(output);
	} catch {
		return undefined;
	}
}

function isContextSearchAnswer(value: unknown): value is ContextSearchAnswer {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.answer === "string" &&
		(record.confidence === "low" || record.confidence === "medium" || record.confidence === "high") &&
		Array.isArray(record.citations) &&
		record.citations.every(citation => typeof citation === "string")
	);
}

function renderContextSearchResult(details: ContextSearchDetails): string {
	const lines = [
		"[Context Search]",
		`• Query:          ${details.query}`,
		`• Scope:          ${details.scope}`,
		`• Candidates:     ${details.candidateCount}`,
	];
	if (details.answer) {
		lines.push(
			`• Answer:         ${details.answer.answer}`,
			`• Confidence:     ${details.answer.confidence}`,
			`• Citations:      ${details.answer.citations.length > 0 ? details.answer.citations.join(", ") : "none"}`,
		);
	} else if (details.extractionError) {
		lines.push(`• Extractor error: ${details.extractionError}`);
	} else if (details.candidateCount === 0) {
		lines.push("• Answer:         No matching conversation history found.");
	}
	lines.push("---------------------------------------------------");
	for (const candidate of details.candidates) {
		const label = candidate.label ? ` tag: ${candidate.label}` : "";
		lines.push(
			`- ${candidate.id} [${candidate.role}/${candidate.type}] score=${candidate.score.toFixed(2)}${label}`,
			`  ${candidate.preview}`,
		);
	}
	return lines.join("\n");
}

function flattenTree(tree: SessionTreeNode[]): SessionEntry[] {
	const entries: SessionEntry[] = [];
	const stack = [...tree].reverse();
	while (stack.length > 0) {
		const node = stack.pop()!;
		entries.push(node.entry);
		for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
	}
	return entries;
}

function compareScoredDocuments(left: ScoredDocument, right: ScoredDocument): number {
	return right.score - left.score || right.document.entry.timestamp.localeCompare(left.document.entry.timestamp);
}

function toCandidate(result: ScoredDocument, maxContextChars: number): ContextSearchCandidate {
	const text = truncate(result.document.text, maxContextChars);
	return {
		id: result.document.id,
		type: result.document.type,
		role: result.document.role,
		...(result.document.label ? { label: result.document.label } : {}),
		timestamp: result.document.timestamp,
		score: Number(result.score.toFixed(4)),
		text,
		preview: normalizePreview(text, 180),
	};
}

function buildDocumentFrequencies(documents: SearchDocument[]): Map<string, number> {
	const frequencies = new Map<string, number>();
	for (const document of documents) {
		for (const token of new Set(document.tokens)) {
			frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
		}
	}
	return frequencies;
}

function bm25(
	document: SearchDocument,
	queryTokens: string[],
	documentFrequencies: Map<string, number>,
	documentCount: number,
	averageLength: number,
): number {
	if (queryTokens.length === 0 || document.tokens.length === 0) return 0;
	const termCounts = countTerms(document.tokens);
	const k1 = 1.2;
	const b = 0.75;
	let score = 0;
	for (const token of queryTokens) {
		const frequency = termCounts.get(token) ?? 0;
		if (frequency === 0) continue;
		const documentFrequency = documentFrequencies.get(token) ?? 0;
		const idf = Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
		const denominator = frequency + k1 * (1 - b + b * (document.tokens.length / Math.max(averageLength, 1)));
		score += idf * ((frequency * (k1 + 1)) / denominator);
	}
	return score;
}

function cosineSimilarity(queryTokens: string[], documentTokens: string[]): number {
	if (queryTokens.length === 0 || documentTokens.length === 0) return 0;
	const queryCounts = countTerms(queryTokens);
	const documentCounts = countTerms(documentTokens);
	let dot = 0;
	let queryMagnitude = 0;
	let documentMagnitude = 0;
	for (const value of queryCounts.values()) queryMagnitude += value * value;
	for (const value of documentCounts.values()) documentMagnitude += value * value;
	for (const [token, queryCount] of queryCounts) dot += queryCount * (documentCounts.get(token) ?? 0);
	if (queryMagnitude === 0 || documentMagnitude === 0) return 0;
	return dot / (Math.sqrt(queryMagnitude) * Math.sqrt(documentMagnitude));
}

function diceCoefficient(left: string[], right: string[]): number {
	if (left.length === 0 || right.length === 0) return 0;
	const rightCounts = countTerms(right);
	let overlap = 0;
	for (const trigram of left) {
		const count = rightCounts.get(trigram) ?? 0;
		if (count === 0) continue;
		overlap++;
		rightCounts.set(trigram, count - 1);
	}
	return (2 * overlap) / (left.length + right.length);
}

function countTerms(tokens: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
	return counts;
}

function tokenize(text: string): string[] {
	return normalizeForSearch(text)
		.split(/[^\p{L}\p{N}_]+/u)
		.map(token => token.trim())
		.filter(Boolean);
}

function trigrams(text: string): string[] {
	const compact = text.replace(/\s+/g, "");
	if (compact.length === 0) return [];
	if (compact.length <= 3) return [compact];
	const grams: string[] = [];
	for (let i = 0; i <= compact.length - 3; i++) grams.push(compact.slice(i, i + 3));
	return grams;
}

function normalizeForSearch(text: string): string {
	return text.toLowerCase().normalize("NFKC");
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength).trimEnd()}...`;
}

function clampInteger(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.floor(value)));
}
