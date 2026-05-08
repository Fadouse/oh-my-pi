import * as nodeCrypto from "node:crypto";
import * as fs from "node:fs";
import * as tls from "node:tls";
import Anthropic, { type ClientOptions as AnthropicSdkClientOptions } from "@anthropic-ai/sdk";
import type {
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
	RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import { $env, abortableSleep, isEnoent, logger, readSseEvents } from "@oh-my-pi/pi-utils";
import { hasOpus47ApiRestrictions, mapEffortToAnthropicAdaptiveEffort } from "../model-thinking";
import { calculateCost } from "../models";
import { getEnvApiKey, OUTPUT_FALLBACK_BUFFER } from "../stream";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	ProviderSessionState,
	RedactedThinkingContent,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../types";
import {
	isAnthropicOAuthToken,
	isRecord,
	normalizeSystemPrompts,
	normalizeToolCallId,
	resolveCacheRetention,
} from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { isFoundryEnabled } from "../utils/foundry";
import { finalizeErrorMessage, type RawHttpRequestDump, rewriteCopilotError } from "../utils/http-inspector";
import { createWatchdog, getStreamFirstEventTimeoutMs } from "../utils/idle-iterator";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse";
import { buildAnthropicMetadataUserId, isAnthropicMetadataUserId } from "../utils/oauth/anthropic-metadata";
import { parseGitHubCopilotApiKey } from "../utils/oauth/github-copilot";
import { notifyProviderResponse } from "../utils/provider-response";
import { extractHttpStatusFromError, isCopilotRetryableError, isUnexpectedSocketCloseMessage } from "../utils/retry";
import { COMBINATOR_KEYS, NO_STRICT } from "../utils/schema";
import {
	buildCopilotDynamicHeaders,
	hasCopilotVisionInput,
	resolveGitHubCopilotBaseUrl,
} from "./github-copilot-headers";
import { transformMessages } from "./transform-messages";

export type AnthropicHeaderOptions = {
	apiKey: string;
	baseUrl?: string;
	isOAuth?: boolean;
	extraBetas?: string[];
	stream?: boolean;
	modelHeaders?: Record<string, string>;
	isCloudflareAiGateway?: boolean;
	modelId?: string;
	sessionId?: string;
};

export function normalizeAnthropicBaseUrl(baseUrl?: string): string | undefined {
	const trimmed = baseUrl?.trim();
	if (!trimmed) {
		return undefined;
	}
	const withoutTrailingSlashes = trimmed.replace(/\/+$/, "");
	return withoutTrailingSlashes.endsWith("/v1") ? withoutTrailingSlashes.slice(0, -3) : withoutTrailingSlashes;
}

// Build deduplicated beta header string
export function buildBetaHeader(baseBetas: string[], extraBetas: string[]): string {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const beta of [...baseBetas, ...extraBetas]) {
		const trimmed = beta.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			result.push(trimmed);
		}
	}
	return result.join(",");
}

const claudeCodeBetaDefaults = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	"redact-thinking-2026-02-12",
	"prompt-caching-scope-2026-01-05",
	"context-management-2025-06-27",
	"advisor-tool-2026-03-01",
];
const claudeCodeLongContextBeta = "context-1m-2025-08-07";
const claudeCodeEffortBeta = "effort-2025-11-24";
const fineGrainedToolStreamingBeta = "fine-grained-tool-streaming-2025-05-14";
const interleavedThinkingBeta = "interleaved-thinking-2025-05-14";
const toolSearchBetaHeader = "advanced-tool-use-2025-11-20";
const defaultAutoToolSearchPercentage = 10;
const toolSearchCharsPerToken = 2.5;

function getHeaderCaseInsensitive(headers: Record<string, string> | undefined, headerName: string): string | undefined {
	if (!headers) return undefined;
	const normalizedName = headerName.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === normalizedName) return value;
	}
	return undefined;
}

function isClaudeCodeClientUserAgent(userAgent: string | undefined): userAgent is string {
	if (!userAgent) return false;
	return userAgent.toLowerCase().startsWith("claude-cli");
}

function isAnthropicApiBaseUrl(baseUrl?: string): boolean {
	if (!baseUrl) return true;
	try {
		const url = new URL(baseUrl);
		return url.protocol.toLowerCase() === "https:" && url.hostname.toLowerCase() === "api.anthropic.com";
	} catch {
		return false;
	}
}

const sharedHeaders = {
	"Accept-Encoding": "gzip, deflate, br, zstd",
	Connection: "keep-alive",
	"Content-Type": "application/json",
	"Anthropic-Version": "2023-06-01",
	"Anthropic-Dangerous-Direct-Browser-Access": "true",
	"X-App": "cli",
};

const claudeCodeRequestSessionId = nodeCrypto.randomUUID();

function supportsClaudeCodeLongContextBeta(modelId: string | undefined): boolean {
	if (!modelId) return false;
	const lower = modelId.toLowerCase();
	if (!lower.includes("opus") && !lower.includes("sonnet")) return false;
	const versionMatch = /(opus|sonnet)-(\d+)-(\d+)/.exec(lower);
	if (!versionMatch) return false;
	const major = Number(versionMatch[2]);
	const minor = Number(versionMatch[3]);
	const effectiveMinor = minor > 99 ? 0 : minor;
	return major > 4 || (major === 4 && effectiveMinor >= 6);
}

function getClaudeCodeBetas(modelId: string | undefined, extraBetas: string[]): string[] {
	const defaults = claudeCodeBetaDefaults.filter(beta => {
		if (modelId?.toLowerCase().includes("haiku") && beta === interleavedThinkingBeta) return false;
		return true;
	});
	const modelSpecificBetas: string[] = [];
	const lowerModelId = modelId?.toLowerCase() ?? "";
	if (lowerModelId.includes("4-6") || lowerModelId.includes("4-7")) {
		modelSpecificBetas.push(claudeCodeEffortBeta);
	}
	if (
		($env.ANTHROPIC_ENABLE_1M_CONTEXT ?? "").toLowerCase() === "true" &&
		supportsClaudeCodeLongContextBeta(modelId)
	) {
		modelSpecificBetas.push(claudeCodeLongContextBeta);
	}
	return [...defaults, ...modelSpecificBetas, ...extraBetas];
}

export function buildAnthropicHeaders(options: AnthropicHeaderOptions): Record<string, string> {
	const oauthToken = options.isOAuth ?? isAnthropicOAuthToken(options.apiKey);
	const extraBetas = options.extraBetas ?? [];
	const stream = options.stream ?? false;
	const betaHeader = buildBetaHeader(getClaudeCodeBetas(options.modelId, extraBetas), []);
	const acceptHeader = oauthToken ? "application/json" : stream ? "text/event-stream" : "application/json";
	const modelHeaders = Object.fromEntries(
		Object.entries(options.modelHeaders ?? {}).filter(([key]) => !enforcedHeaderKeys.has(key.toLowerCase())),
	);

	if (options.isCloudflareAiGateway) {
		return {
			...modelHeaders,
			Accept: acceptHeader,
			...sharedHeaders,
			"Anthropic-Beta": betaHeader,
			"cf-aig-authorization": `Bearer ${options.apiKey}`,
		};
	}

	if (oauthToken) {
		const incomingUserAgent = getHeaderCaseInsensitive(options.modelHeaders, "User-Agent");
		const userAgent = isClaudeCodeClientUserAgent(incomingUserAgent)
			? incomingUserAgent
			: `claude-cli/${claudeCodeVersion} (external, cli)`;
		return {
			...modelHeaders,
			...claudeCodeHeaders,
			Accept: acceptHeader,
			Authorization: `Bearer ${options.apiKey}`,
			...sharedHeaders,
			"Anthropic-Beta": betaHeader,
			"User-Agent": userAgent,
			"x-client-request-id": nodeCrypto.randomUUID(),
			"X-Claude-Code-Session-Id": options.sessionId ?? claudeCodeRequestSessionId,
		};
	} else if (!isAnthropicApiBaseUrl(options.baseUrl)) {
		return {
			...modelHeaders,
			Accept: acceptHeader,
			Authorization: `Bearer ${options.apiKey}`,
			...sharedHeaders,
			"Anthropic-Beta": betaHeader,
		};
	} else {
		return {
			...modelHeaders,
			Accept: acceptHeader,
			...sharedHeaders,
			"Anthropic-Beta": betaHeader,
			"X-Api-Key": options.apiKey,
		};
	}
}

export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

type AnthropicCacheScope = "global" | "org";
type AnthropicCacheControl = {
	type: "ephemeral";
	ttl?: "1h" | "5m";
	scope?: AnthropicCacheScope;
};

export type AnthropicCacheEditsBlock = {
	type: "cache_edits";
	edits: Array<{ type: "delete"; cache_reference: string }>;
};

export type AnthropicPinnedCacheEdits = {
	userMessageIndex: number;
	block: AnthropicCacheEditsBlock;
};

type AnthropicCachePolicy = {
	enabled: boolean;
	retention: CacheRetention;
	ttl?: "1h";
	supportsScope: boolean;
	useGlobalSystemCache: boolean;
	skipGlobalCacheForSystemPrompt: boolean;
};

type AnthropicSamplingParams = MessageCreateParamsStreaming & {
	top_p?: number;
	top_k?: number;
};

function getPromptCachingEnabled(modelId: string): boolean {
	if (($env.DISABLE_PROMPT_CACHING ?? "").toLowerCase() === "true") return false;
	if (($env.DISABLE_PROMPT_CACHING_HAIKU ?? "").toLowerCase() === "true" && modelId.includes("haiku")) return false;
	if (($env.DISABLE_PROMPT_CACHING_SONNET ?? "").toLowerCase() === "true" && modelId.includes("sonnet")) return false;
	if (($env.DISABLE_PROMPT_CACHING_OPUS ?? "").toLowerCase() === "true" && modelId.includes("opus")) return false;
	return true;
}

function isEnvTruthy(value: string | undefined): boolean {
	return value?.toLowerCase() === "true" || value === "1";
}

/**
 * Adaptive thinking `display` is supported starting with Claude Opus 4.7.
 * Older adaptive-thinking models (Opus 4.6, Sonnet 4.6+) reject the field.
 */
function supportsAdaptiveThinkingDisplay(modelId: string): boolean {
	const match = /claude-opus-(\d+)-(\d+)/.exec(modelId);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 4 || (major === 4 && minor >= 7);
}

const ANTHROPIC_PROVIDER_SESSION_STATE_KEY = "anthropic-messages";
type AnthropicCacheDiagnosticsState = {
	previousHash: string | null;
	previousCacheReadTokens: number | null;
};

type AnthropicProviderSessionState = ProviderSessionState & {
	strictToolsDisabled: boolean;
	cacheDiagnostics: Map<string, AnthropicCacheDiagnosticsState>;
	cacheEditingHeaderLatched: boolean;
};

function createAnthropicProviderSessionState(): AnthropicProviderSessionState {
	const state: AnthropicProviderSessionState = {
		strictToolsDisabled: false,
		cacheDiagnostics: new Map(),
		cacheEditingHeaderLatched: false,
		close: () => {
			state.strictToolsDisabled = false;
			state.cacheEditingHeaderLatched = false;
			state.cacheDiagnostics.clear();
		},
	};
	return state;
}

function getAnthropicProviderSessionState(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): AnthropicProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const existing = providerSessionState.get(ANTHROPIC_PROVIDER_SESSION_STATE_KEY) as
		| AnthropicProviderSessionState
		| undefined;
	if (existing) return existing;
	const created = createAnthropicProviderSessionState();
	providerSessionState.set(ANTHROPIC_PROVIDER_SESSION_STATE_KEY, created);
	return created;
}

function isAnthropicStrictGrammarTooLargeError(error: unknown): boolean {
	if (extractHttpStatusFromError(error) !== 400) return false;
	const message = error instanceof Error ? error.message : String(error);
	const isStrictGrammarTooLarge = /compiled grammar/i.test(message) && /too large/i.test(message);
	const isSchemaCompilationTooComplex =
		/schema/i.test(message) && /too complex/i.test(message) && /compil/i.test(message);
	return /invalid_request_error/i.test(message) && (isStrictGrammarTooLarge || isSchemaCompilationTooComplex);
}

function hasStrictAnthropicTools(params: MessageCreateParamsStreaming): boolean {
	const tools = params.tools as Array<{ strict?: unknown }> | undefined;
	return tools?.some(tool => tool.strict === true) ?? false;
}

function dropAnthropicStrictTools(params: MessageCreateParamsStreaming): void {
	const tools = params.tools as Array<{ strict?: unknown }> | undefined;
	if (!tools) return;
	for (const tool of tools) {
		delete tool.strict;
	}
}

function getCachePolicy(
	model: Model<"anthropic-messages">,
	baseUrl: string,
	options?: AnthropicOptions,
): AnthropicCachePolicy {
	const retention = resolveCacheRetention(options?.cacheRetention);
	const enabled = (options?.enablePromptCaching ?? true) && retention !== "none" && getPromptCachingEnabled(model.id);
	const firstPartyAnthropic = model.provider === "anthropic" && isAnthropicApiBaseUrl(baseUrl);
	const supportsScope = firstPartyAnthropic && !isEnvTruthy($env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS);
	const ttl =
		enabled &&
		retention === "long" &&
		isAnthropicApiBaseUrl(baseUrl) &&
		getAnthropicCompat(model).supportsLongCacheRetention
			? "1h"
			: undefined;
	return {
		enabled,
		retention,
		...(ttl && { ttl }),
		supportsScope,
		useGlobalSystemCache: supportsScope,
		skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt ?? false,
	};
}

function createCacheControl(
	policy: AnthropicCachePolicy,
	scope?: AnthropicCacheScope,
): AnthropicCacheControl | undefined {
	if (!policy.enabled) return undefined;
	return {
		type: "ephemeral",
		...(policy.ttl && { ttl: policy.ttl }),
		...(scope === "global" && policy.supportsScope && { scope }),
	};
}

// Stealth mode: Mimic Claude Code headers and tool prefixing.
export const claudeCodeVersion = "2.1.126";
export const claudeToolPrefix: string = "mcp_";
export const claudeCodeSystemInstruction = "You are Claude Code, Anthropic's official CLI for Claude.";

export function mapStainlessOs(platform: string): "MacOS" | "Windows" | "Linux" | "FreeBSD" | `Other::${string}` {
	switch (platform.toLowerCase()) {
		case "darwin":
			return "MacOS";
		case "windows":
		case "win32":
			return "Windows";
		case "linux":
			return "Linux";
		case "freebsd":
			return "FreeBSD";
		default:
			return `Other::${platform.toLowerCase()}`;
	}
}

export function mapStainlessArch(arch: string): "x64" | "arm64" | "x86" | `other::${string}` {
	switch (arch.toLowerCase()) {
		case "amd64":
		case "x64":
			return "x64";
		case "arm64":
		case "aarch64":
			return "arm64";
		case "386":
		case "x86":
		case "ia32":
			return "x86";
		default:
			return `other::${arch.toLowerCase()}`;
	}
}

export const claudeCodeHeaders = {
	"X-Stainless-Retry-Count": "0",
	"X-Stainless-Runtime-Version": "v24.3.0",
	"X-Stainless-Package-Version": "0.81.0",
	"X-Stainless-Runtime": "node",
	"X-Stainless-Lang": "js",
	"X-Stainless-Arch": mapStainlessArch(process.arch),
	"X-Stainless-Os": mapStainlessOs(process.platform),
	"X-Stainless-Timeout": "600",
} as const;

const enforcedHeaderKeys = new Set(
	[
		...Object.keys(claudeCodeHeaders),
		"Accept",
		"Accept-Encoding",
		"Connection",
		"Content-Type",
		"Anthropic-Version",
		"Anthropic-Dangerous-Direct-Browser-Access",
		"Anthropic-Beta",
		"User-Agent",
		"X-App",
		"Authorization",
		"X-Api-Key",
		"x-client-request-id",
		"X-Claude-Code-Session-Id",
		"cf-aig-authorization",
	].map(key => key.toLowerCase()),
);

const CLAUDE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
const CLAUDE_BILLING_SALT = "59cf53e54c78";
const CLAUDE_BILLING_CCH_SLOT = "cch=00000";
const CLAUDE_CCH_SEED = 0x6e52736ac806831en;
const XXH64_MASK = 0xffffffffffffffffn;
const XXH64_PRIME_1 = 0x9e3779b185ebca87n;
const XXH64_PRIME_2 = 0xc2b2ae3d27d4eb4fn;
const XXH64_PRIME_3 = 0x165667b19e3779f9n;
const XXH64_PRIME_4 = 0x85ebca77c2b2ae63n;
const XXH64_PRIME_5 = 0x27d4eb2f165667c5n;

function xxh64RotateLeft(value: bigint, bits: bigint): bigint {
	const shift = Number(bits);
	return ((value << bits) & XXH64_MASK) | ((value & XXH64_MASK) >> BigInt(64 - shift));
}

function xxh64Round(accumulator: bigint, input: bigint): bigint {
	let next = (accumulator + ((input * XXH64_PRIME_2) & XXH64_MASK)) & XXH64_MASK;
	next = xxh64RotateLeft(next, 31n);
	return (next * XXH64_PRIME_1) & XXH64_MASK;
}

function xxh64MergeRound(accumulator: bigint, value: bigint): bigint {
	let next = accumulator ^ xxh64Round(0n, value);
	next = (next * XXH64_PRIME_1 + XXH64_PRIME_4) & XXH64_MASK;
	return next;
}

function xxh64Avalanche(value: bigint): bigint {
	let next = value;
	next ^= next >> 33n;
	next = (next * XXH64_PRIME_2) & XXH64_MASK;
	next ^= next >> 29n;
	next = (next * XXH64_PRIME_3) & XXH64_MASK;
	next ^= next >> 32n;
	return next & XXH64_MASK;
}

function readUint64LE(bytes: Uint8Array, offset: number): bigint {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return view.getBigUint64(offset, true);
}

function readUint32LE(bytes: Uint8Array, offset: number): bigint {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return BigInt(view.getUint32(offset, true));
}

export function computeClaudeCch(bodyText: string): string {
	const bodyBytes = new TextEncoder().encode(bodyText);
	const length = bodyBytes.length;
	let offset = 0;
	let hash: bigint;

	if (length >= 32) {
		let value1 = (CLAUDE_CCH_SEED + XXH64_PRIME_1 + XXH64_PRIME_2) & XXH64_MASK;
		let value2 = (CLAUDE_CCH_SEED + XXH64_PRIME_2) & XXH64_MASK;
		let value3 = CLAUDE_CCH_SEED & XXH64_MASK;
		let value4 = (CLAUDE_CCH_SEED - XXH64_PRIME_1) & XXH64_MASK;
		while (offset + 32 <= length) {
			value1 = xxh64Round(value1, readUint64LE(bodyBytes, offset));
			offset += 8;
			value2 = xxh64Round(value2, readUint64LE(bodyBytes, offset));
			offset += 8;
			value3 = xxh64Round(value3, readUint64LE(bodyBytes, offset));
			offset += 8;
			value4 = xxh64Round(value4, readUint64LE(bodyBytes, offset));
			offset += 8;
		}
		hash =
			(xxh64RotateLeft(value1, 1n) +
				xxh64RotateLeft(value2, 7n) +
				xxh64RotateLeft(value3, 12n) +
				xxh64RotateLeft(value4, 18n)) &
			XXH64_MASK;
		hash = xxh64MergeRound(hash, value1);
		hash = xxh64MergeRound(hash, value2);
		hash = xxh64MergeRound(hash, value3);
		hash = xxh64MergeRound(hash, value4);
	} else {
		hash = (CLAUDE_CCH_SEED + XXH64_PRIME_5) & XXH64_MASK;
	}

	hash = (hash + BigInt(length)) & XXH64_MASK;
	while (offset + 8 <= length) {
		const lane = xxh64Round(0n, readUint64LE(bodyBytes, offset));
		hash ^= lane;
		hash = (xxh64RotateLeft(hash, 27n) * XXH64_PRIME_1 + XXH64_PRIME_4) & XXH64_MASK;
		offset += 8;
	}
	if (offset + 4 <= length) {
		hash ^= (readUint32LE(bodyBytes, offset) * XXH64_PRIME_1) & XXH64_MASK;
		hash = (xxh64RotateLeft(hash, 23n) * XXH64_PRIME_2 + XXH64_PRIME_3) & XXH64_MASK;
		offset += 4;
	}
	while (offset < length) {
		hash ^= (BigInt(bodyBytes[offset] ?? 0) * XXH64_PRIME_5) & XXH64_MASK;
		hash = (xxh64RotateLeft(hash, 11n) * XXH64_PRIME_1) & XXH64_MASK;
		offset += 1;
	}

	return (xxh64Avalanche(hash) & 0xfffffn).toString(16).padStart(5, "0");
}

function extractFirstUserMessageText(messages: MessageCreateParamsStreaming["messages"] | undefined): string {
	const userMessage = messages?.find(message => message.role === "user");
	const content = userMessage?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const textBlock = content.find(block => block.type === "text") as { type?: string; text?: unknown } | undefined;
		if (textBlock?.type === "text" && typeof textBlock.text === "string") return textBlock.text;
	}
	return "";
}

export function computeClaudeVersionSuffix(messageText: string, version: string = claudeCodeVersion): string {
	const sampled = [4, 7, 20].map(index => (index < messageText.length ? messageText[index] : "0")).join("");
	return nodeCrypto
		.createHash("sha256")
		.update(`${CLAUDE_BILLING_SALT}${sampled}${version}`)
		.digest("hex")
		.slice(0, 3);
}

function createClaudeBillingHeader(payload: unknown): string {
	const messages =
		isRecord(payload) && Array.isArray(payload.messages)
			? (payload.messages as MessageCreateParamsStreaming["messages"])
			: undefined;
	const versionSuffix = computeClaudeVersionSuffix(extractFirstUserMessageText(messages));
	return `${CLAUDE_BILLING_HEADER_PREFIX} cc_version=${claudeCodeVersion}.${versionSuffix}; cc_entrypoint=cli; ${CLAUDE_BILLING_CCH_SLOT};`;
}

function finalizeClaudeBillingHeaderCch(params: MessageCreateParamsStreaming): void {
	if (!Array.isArray(params.system)) return;
	const systemBlocks = params.system as AnthropicSystemBlock[];
	const billingBlock = systemBlocks.find(block => block.text.includes(CLAUDE_BILLING_CCH_SLOT));
	if (!billingBlock) return;
	const cch = computeClaudeCch(JSON.stringify(params));
	billingBlock.text = billingBlock.text.replace(CLAUDE_BILLING_CCH_SLOT, `cch=${cch}`);
}

export function isClaudeCodeMetadataUserId(userId: string): boolean {
	return isAnthropicMetadataUserId(userId);
}

export function generateClaudeCloakingUserId(): string {
	return JSON.stringify(buildAnthropicMetadataUserId(undefined, claudeCodeRequestSessionId));
}

export function isClaudeCloakingUserId(userId: string): boolean {
	return isClaudeCodeMetadataUserId(userId);
}

function resolveAnthropicMetadataUserId(
	userId: unknown,
	isOAuthToken: boolean,
	sessionId: string | undefined,
): string | undefined {
	if (!isOAuthToken) return typeof userId === "string" ? userId : undefined;
	return JSON.stringify(buildAnthropicMetadataUserId(userId, sessionId ?? claudeCodeRequestSessionId));
}
const ANTHROPIC_BUILTIN_TOOL_NAMES = new Set(["web_search", "code_execution", "text_editor", "computer"]);
export const applyClaudeToolPrefix = (name: string, prefixOverride: string = claudeToolPrefix) => {
	if (!prefixOverride) return name;
	if (ANTHROPIC_BUILTIN_TOOL_NAMES.has(name.toLowerCase())) return name;
	const prefix = prefixOverride.toLowerCase();
	if (name.toLowerCase().startsWith(prefix)) return name;
	return `${prefixOverride}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
};

export const stripClaudeToolPrefix = (name: string, prefixOverride: string = claudeToolPrefix) => {
	if (!prefixOverride) return name;
	const prefix = prefixOverride.toLowerCase();
	if (!name.toLowerCase().startsWith(prefix)) return name;
	const stripped = name.slice(prefixOverride.length);
	return `${stripped.charAt(0).toLowerCase()}${stripped.slice(1)}`;
};

/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(
	content: (TextContent | ImageContent)[],
	isOAuthToken: boolean,
	options?: { toolSearchEnabled?: boolean; availableToolNames?: ReadonlySet<string> },
):
	| string
	| Array<
			| { type: "text"; text: string }
			| { type: "tool_reference"; tool_name: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	// If only text blocks, return as concatenated string for simplicity
	const hasImages = content.some(c => c.type === "image");
	const hasToolReferences = content.some(c => c.type === "text" && typeof c.toolReferenceName === "string");
	if (!hasImages && !hasToolReferences) {
		return content
			.map(c => (c as TextContent).text)
			.join("\n")
			.toWellFormed();
	}

	// If we have images, convert to content block array
	const blocks = content.map(block => {
		if (block.type === "text") {
			if (block.toolReferenceName) {
				if (options?.toolSearchEnabled !== true) {
					return {
						type: "text" as const,
						text: "[Tool references removed - tool search not enabled]",
					};
				}
				if (options.availableToolNames && !options.availableToolNames.has(block.toolReferenceName)) {
					return {
						type: "text" as const,
						text: "[Tool references removed - tools no longer available]",
					};
				}
				return {
					type: "tool_reference" as const,
					tool_name: isOAuthToken ? applyClaudeToolPrefix(block.toolReferenceName) : block.toolReferenceName,
				};
			}
			return {
				type: "text" as const,
				text: block.text.toWellFormed(),
			};
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	// If only images (no text), add placeholder text block
	const hasText = blocks.some(b => b.type === "text");
	if (!hasText && !hasToolReferences) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type AnthropicThinkingDisplay = "summarized" | "omitted";

export interface AnthropicOptions extends StreamOptions {
	/**
	 * Enable extended thinking.
	 * For Opus 4.6+: uses adaptive thinking (Claude decides when/how much to think).
	 * For older models: uses budget-based thinking with thinkingBudgetTokens.
	 */
	thinkingEnabled?: boolean;
	/**
	 * Token budget for extended thinking (older models only).
	 * Ignored for Opus 4.6+ which uses adaptive thinking.
	 */
	thinkingBudgetTokens?: number;
	/**
	 * Effort level for adaptive thinking (Opus 4.6+ only).
	 * Controls how much thinking Claude allocates:
	 * - "max": Always thinks with no constraints
	 * - "high": Always thinks, deep reasoning (default)
	 * - "medium": Moderate thinking, may skip for simple queries
	 * - "low": Minimal thinking, skips for simple tasks
	 * Ignored for older models.
	 */
	effort?: AnthropicEffort;
	/**
	 * Optional reasoning level fallback for direct Anthropic provider usage.
	 * Converted to adaptive effort when effort is not explicitly provided.
	 */
	reasoning?: SimpleStreamOptions["reasoning"];
	/**
	 * Controls how Anthropic returns thinking content when the selected thinking
	 * transport supports a display option. Defaults to "summarized" where the
	 * API accepts it.
	 */
	thinkingDisplay?: AnthropicThinkingDisplay;
	interleavedThinking?: boolean;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	betas?: string[] | string;
	/** Explicitly overrides official prompt-caching enablement for Anthropic request shaping. */
	enablePromptCaching?: boolean;
	/** Claude Code query source used by prompt-cache TTL/cache-editing gates. */
	querySource?: string;
	/** Force system prompt global-cache splitting off, matching Claude Code's MCP-tool gate. */
	skipGlobalCacheForSystemPrompt?: boolean;
	/** Enables Claude Code cached microcompact request shaping when first-party and querySource is repl_main_thread. */
	useCachedMicrocompact?: boolean;
	/** New cache_edits block to insert into the last user message for cached microcompact. */
	newCacheEdits?: AnthropicCacheEditsBlock | null;
	/** Pinned cache_edits blocks to reinsert at their original user-message indices. */
	pinnedCacheEdits?: AnthropicPinnedCacheEdits[];
	/** Called with the original new cache_edits block after it is inserted and should be pinned. */
	onPinCacheEdits?: (userMessageIndex: number, block: AnthropicCacheEditsBlock) => void;
	/** Anthropic beta header for cache editing; provided source does not define the private constant. */
	cacheEditingBetaHeader?: string;
	/** Force OAuth bearer auth mode for proxy tokens that don't match Anthropic token prefixes. */
	isOAuth?: boolean;
	/**
	 * Pre-built Anthropic client instance. When provided, skips internal client
	 * construction entirely. Use this to inject alternative SDK clients such as
	 * `AnthropicVertex` that shares the same messaging API.
	 */
	client?: Anthropic;
}

export type AnthropicClientOptionsArgs = {
	model: Model<"anthropic-messages">;
	apiKey: string;
	extraBetas?: string[];
	stream?: boolean;
	interleavedThinking?: boolean;
	headers?: Record<string, string>;
	dynamicHeaders?: Record<string, string>;
	isOAuth?: boolean;
	hasTools?: boolean;
	sessionId?: string;
};

export type AnthropicClientOptionsResult = {
	isOAuthToken: boolean;
	apiKey: string | null;
	authToken?: string | null;
	baseURL?: string;
	maxRetries: number;
	dangerouslyAllowBrowser: boolean;
	defaultHeaders: Record<string, string>;
	logLevel: AnthropicSdkClientOptions["logLevel"];
	fetchOptions?: AnthropicSdkClientOptions["fetchOptions"];
};

const CLAUDE_CODE_TLS_CIPHERS = tls.DEFAULT_CIPHERS;

type FoundryTlsOptions = {
	ca?: string | string[];
	cert?: string;
	key?: string;
};

function resolveAnthropicBaseUrl(model: Model<"anthropic-messages">, apiKey?: string): string | undefined {
	if (model.provider === "github-copilot") {
		return normalizeAnthropicBaseUrl(resolveGitHubCopilotBaseUrl(model.baseUrl, apiKey) ?? model.baseUrl);
	}
	if (model.provider === "anthropic" && isFoundryEnabled()) {
		const foundryBaseUrl = normalizeAnthropicBaseUrl($env.FOUNDRY_BASE_URL);
		if (foundryBaseUrl) {
			return foundryBaseUrl;
		}
	}
	if (model.provider === "anthropic") {
		return normalizeAnthropicBaseUrl(model.baseUrl) ?? "https://api.anthropic.com";
	}
	return normalizeAnthropicBaseUrl(model.baseUrl);
}

function parseAnthropicCustomHeaders(rawHeaders: string | undefined): Record<string, string> | undefined {
	const source = rawHeaders?.trim();
	if (!source) return undefined;

	const parsed: Record<string, string> = {};
	for (const token of source.split(/\r?\n|,/)) {
		const entry = token.trim();
		if (!entry) continue;
		const separatorIndex = entry.indexOf(":");
		if (separatorIndex <= 0) continue;
		const key = entry.slice(0, separatorIndex).trim();
		const value = entry.slice(separatorIndex + 1).trim();
		if (!key || !value) continue;
		parsed[key] = value;
	}

	return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function resolveAnthropicCustomHeaders(model: Model<"anthropic-messages">): Record<string, string> | undefined {
	if (model.provider !== "anthropic") return undefined;
	if (!isFoundryEnabled()) return undefined;
	return parseAnthropicCustomHeaders($env.ANTHROPIC_CUSTOM_HEADERS);
}

function looksLikeFilePath(value: string): boolean {
	return value.includes("/") || value.includes("\\") || /\.(pem|crt|cer|key)$/i.test(value);
}

function resolvePemValue(value: string | undefined, name: string): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;

	const inline = trimmed.replace(/\\n/g, "\n");
	if (inline.includes("-----BEGIN")) {
		return inline;
	}

	if (looksLikeFilePath(trimmed)) {
		try {
			return fs.readFileSync(trimmed, "utf8");
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error(`${name} path does not exist: ${trimmed}`);
			}
			throw error;
		}
	}

	return inline;
}

function resolveFoundryTlsOptions(model: Model<"anthropic-messages">): FoundryTlsOptions | undefined {
	if (model.provider !== "anthropic") return undefined;
	if (!isFoundryEnabled()) return undefined;

	const ca = resolvePemValue($env.NODE_EXTRA_CA_CERTS, "NODE_EXTRA_CA_CERTS");
	const cert = resolvePemValue($env.CLAUDE_CODE_CLIENT_CERT, "CLAUDE_CODE_CLIENT_CERT");
	const key = resolvePemValue($env.CLAUDE_CODE_CLIENT_KEY, "CLAUDE_CODE_CLIENT_KEY");

	if ((cert && !key) || (!cert && key)) {
		throw new Error("Both CLAUDE_CODE_CLIENT_CERT and CLAUDE_CODE_CLIENT_KEY must be set for mTLS.");
	}

	const options: FoundryTlsOptions = {};
	if (ca) options.ca = [...tls.rootCertificates, ca];
	if (cert) options.cert = cert;
	if (key) options.key = key;
	return Object.keys(options).length > 0 ? options : undefined;
}

function buildClaudeCodeTlsFetchOptions(
	model: Model<"anthropic-messages">,
	baseUrl: string | undefined,
): AnthropicSdkClientOptions["fetchOptions"] | undefined {
	if (model.provider !== "anthropic") return undefined;
	if (!baseUrl) return undefined;

	let serverName: string;
	try {
		serverName = new URL(baseUrl).hostname;
	} catch {
		return undefined;
	}

	if (!serverName) return undefined;

	const foundryTlsOptions = resolveFoundryTlsOptions(model);

	return {
		tls: {
			rejectUnauthorized: true,
			serverName,
			...(CLAUDE_CODE_TLS_CIPHERS ? { ciphers: CLAUDE_CODE_TLS_CIPHERS } : {}),
			...(foundryTlsOptions ?? {}),
		},
	};
}
function mergeHeaders(...headerSources: (Record<string, string> | undefined)[]): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

// The Anthropic SDK logs malformed SSE frames directly before rethrowing them.
// We surface the resulting provider error ourselves, so keep the SDK quiet.
const ANTHROPIC_SDK_LOG_LEVEL = "off" as const;

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
	if (!response.body) {
		throw new Error("Attempted to iterate over an Anthropic response with no body");
	}

	let sawMessageStart = false;
	let sawMessageEnd = false;

	for await (const sse of readSseEvents(response.body, signal)) {
		if (sse.event === "error") {
			throw new Error(sse.data);
		}

		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			continue;
		}

		try {
			const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
			if (event.type === "message_start") {
				sawMessageStart = true;
			} else if (event.type === "message_stop") {
				sawMessageEnd = true;
			}
			yield event;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
			);
		}
	}

	if (sawMessageStart && !sawMessageEnd) {
		throw createAnthropicStreamEnvelopeError("stream ended before message_stop");
	}
}

type AnthropicRawResponseRequest = {
	asResponse(): Promise<Response>;
};

function hasAnthropicRawResponseRequest(request: unknown): request is AnthropicRawResponseRequest {
	return isRecord(request) && typeof request.asResponse === "function";
}

type AnthropicStreamWithResponseRequest = {
	withResponse(): Promise<{
		data: AsyncIterable<RawMessageStreamEvent>;
		response: Response;
		request_id: string | null;
	}>;
};

function hasAnthropicStreamWithResponseRequest(request: unknown): request is AnthropicStreamWithResponseRequest {
	return isRecord(request) && typeof request.withResponse === "function";
}

async function getAnthropicStreamResponse(
	request: unknown,
	signal?: AbortSignal,
): Promise<{ events: AsyncIterable<RawMessageStreamEvent>; response: Response; requestId: string | null }> {
	if (hasAnthropicRawResponseRequest(request)) {
		const response = await request.asResponse();
		return {
			events: iterateAnthropicEvents(response, signal),
			response,
			requestId: response.headers.get("request-id"),
		};
	}
	if (hasAnthropicStreamWithResponseRequest(request)) {
		const { data, response, request_id } = await request.withResponse();
		return { events: data, response, requestId: request_id };
	}
	throw new Error("Anthropic SDK request did not expose a stream response");
}

function getAnthropicCompat(
	model: Model<"anthropic-messages">,
): Required<NonNullable<Model<"anthropic-messages">["compat"]>> {
	return {
		disableStrictTools: model.compat?.disableStrictTools ?? false,
		disableAdaptiveThinking: model.compat?.disableAdaptiveThinking ?? false,
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
	};
}

const PROVIDER_MAX_RETRIES = 3;
const PROVIDER_BASE_DELAY_MS = 2000;

/**
 * Check if an error from the Anthropic SDK is a rate-limit/transient error that
 * should be retried before any content has been emitted.
 *
 * Includes malformed JSON stream-envelope parse errors seen from some
 * Anthropic-compatible proxy endpoints.
 */
/** Transient stream corruption errors where the response was truncated mid-JSON. */
function isTransientStreamParseError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return /json parse error|unterminated string|unexpected end of json input/i.test(error.message);
}

const ANTHROPIC_STREAM_ENVELOPE_ERROR_PREFIX = "Anthropic stream envelope error:";

function createAnthropicStreamEnvelopeError(message: string): Error {
	return new Error(`${ANTHROPIC_STREAM_ENVELOPE_ERROR_PREFIX} ${message}`);
}

const ANTHROPIC_PRE_MESSAGE_START_EVENT_TYPES = new Set([
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
	"message_delta",
	"message_stop",
	"message_start",
]);

function shouldIgnoreAnthropicPreambleEvent(eventType: unknown): boolean {
	if (typeof eventType !== "string") return false;
	if (eventType === "ping") return true;
	return !ANTHROPIC_PRE_MESSAGE_START_EVENT_TYPES.has(eventType);
}

function isTransientStreamEnvelopeError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return (
		error.message.includes(ANTHROPIC_STREAM_ENVELOPE_ERROR_PREFIX) ||
		/stream event order|before message_start|before terminal stop signal/i.test(error.message)
	);
}

function isProviderRetryableStreamEnvelopeError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return /stream event order|before message_start/i.test(error.message);
}

export function isProviderRetryableError(error: unknown, provider?: string): boolean {
	if (!(error instanceof Error)) return false;
	if (provider === "github-copilot" && isCopilotRetryableError(error)) return true;
	const msg = error.message.toLowerCase();
	return (
		isUnexpectedSocketCloseMessage(msg) ||
		/rate.?limit|too many requests|overloaded|service.?unavailable|internal_error|stream error.*received from peer|1302|timed?\s*out while waiting for the first event|timeout waiting for first/i.test(
			msg,
		) ||
		isTransientStreamParseError(error) ||
		isProviderRetryableStreamEnvelopeError(error)
	);
}

function createEmptyUsage(premiumRequests?: number): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		...(premiumRequests === undefined ? {} : { premiumRequests }),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export type AnthropicUsageLike = {
	cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
	server_tool_use?: { web_search_requests?: number | null; web_fetch_requests?: number | null } | null;
};

const MIN_CACHE_MISS_TOKENS = 2_000;

function computeAnthropicCacheDiagnosticsHash(
	params: MessageCreateParamsStreaming,
	model: Model<"anthropic-messages">,
): string {
	const diagnosticPayload = {
		model: model.id,
		system: params.system,
		tools: params.tools,
		tool_choice: params.tool_choice,
		thinking: params.thinking,
		output_config: (params as AnthropicSamplingParams).output_config,
		messages: params.messages.map(message => ({
			role: message.role,
			content: Array.isArray(message.content)
				? message.content.map(block => (typeof block === "object" && block !== null ? block : { value: block }))
				: message.content,
		})),
	};
	return nodeCrypto.createHash("sha256").update(JSON.stringify(diagnosticPayload)).digest("hex");
}

function recordAnthropicCacheDiagnostics(args: {
	state: AnthropicProviderSessionState | undefined;
	key: string;
	hash: string | undefined;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	modelId: string;
}): void {
	if (!args.state || !args.hash) return;
	const previous = args.state.cacheDiagnostics.get(args.key) ?? {
		previousHash: null,
		previousCacheReadTokens: null,
	};
	const previousCacheReadTokens = previous.previousCacheReadTokens;
	if (previousCacheReadTokens !== null) {
		const tokenDrop = previousCacheReadTokens - args.cacheReadTokens;
		if (args.cacheReadTokens < previousCacheReadTokens * 0.95 && tokenDrop >= MIN_CACHE_MISS_TOKENS) {
			logger.debug("Anthropic prompt cache read dropped", {
				model: args.modelId,
				previousCacheReadTokens,
				cacheReadTokens: args.cacheReadTokens,
				cacheCreationTokens: args.cacheCreationTokens,
				requestShapeChanged: previous.previousHash !== args.hash,
			});
		}
	}
	args.state.cacheDiagnostics.set(args.key, {
		previousHash: args.hash,
		previousCacheReadTokens: args.cacheReadTokens,
	});
}
/**
 * Capture Anthropic's optional cache-creation TTL breakdown and server-tool-use
 * counters into the harness Usage shape. Only sets fields that were reported, so
 * a `message_delta` that omits `cache_creation` does not clobber the breakdown
 * established at `message_start`.
 */
export function applyAnthropicUsageExtras(usage: Usage, source: AnthropicUsageLike): void {
	const cacheCreation = source.cache_creation;
	if (cacheCreation) {
		const fiveMinute = cacheCreation.ephemeral_5m_input_tokens ?? 0;
		const oneHour = cacheCreation.ephemeral_1h_input_tokens ?? 0;
		if (fiveMinute > 0 || oneHour > 0) {
			usage.cttl = {
				...(fiveMinute > 0 ? { ephemeral5m: fiveMinute } : {}),
				...(oneHour > 0 ? { ephemeral1h: oneHour } : {}),
			};
		}
	}
	const serverToolUse = source.server_tool_use;
	if (serverToolUse) {
		const webSearch = serverToolUse.web_search_requests ?? 0;
		const webFetch = serverToolUse.web_fetch_requests ?? 0;
		if (webSearch > 0 || webFetch > 0) {
			usage.server = {
				...(webSearch > 0 ? { webSearch } : {}),
				...(webFetch > 0 ? { webFetch } : {}),
			};
		}
	}
}

export const streamAnthropic: StreamFunction<"anthropic-messages"> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;

		const copilotDynamicHeaders =
			model.provider === "github-copilot"
				? buildCopilotDynamicHeaders({
						messages: context.messages,
						hasImages: hasCopilotVisionInput(context.messages),
						premiumMultiplier: model.premiumMultiplier,
						headers: { ...(model.headers ?? {}), ...(options?.headers ?? {}) },
						initiatorOverride: options?.initiatorOverride,
					})
				: undefined;
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: createEmptyUsage(copilotDynamicHeaders?.premiumRequests),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let rawRequestDump: RawHttpRequestDump | undefined;
		let activeAbortTracker = createAbortSourceTracker(options?.signal);

		try {
			const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
			const baseUrl = resolveAnthropicBaseUrl(model, apiKey) ?? "https://api.anthropic.com";
			const providerSessionState = getAnthropicProviderSessionState(options?.providerSessionState);
			const isFirstPartyMainThread =
				isFirstPartyAnthropicRequest(model, baseUrl) && options?.querySource === "repl_main_thread";
			if (providerSessionState && options?.useCachedMicrocompact === true && isFirstPartyMainThread) {
				providerSessionState.cacheEditingHeaderLatched = true;
			}
			const extraBetas = normalizeExtraBetas(options?.betas);
			if (
				providerSessionState?.cacheEditingHeaderLatched &&
				isFirstPartyMainThread &&
				options?.cacheEditingBetaHeader
			) {
				extraBetas.push(options.cacheEditingBetaHeader);
			}
			if (shouldUseAnthropicToolSearch(model, baseUrl, context.tools)) {
				extraBetas.push(toolSearchBetaHeader);
			}

			let client: Anthropic;
			let isOAuthToken: boolean;

			if (options?.client) {
				client = options.client;
				isOAuthToken = false;
			} else {
				const created = createClient(model, {
					model,
					apiKey,
					extraBetas,
					stream: true,
					interleavedThinking: options?.interleavedThinking ?? true,
					headers: options?.headers,
					dynamicHeaders: copilotDynamicHeaders?.headers,
					isOAuth: options?.isOAuth,
					hasTools: !!context.tools?.length,
					sessionId: options?.sessionId,
				});
				client = created.client;
				isOAuthToken = created.isOAuthToken;
			}
			let disableStrictTools =
				(providerSessionState?.strictToolsDisabled ?? false) || (model.compat?.disableStrictTools ?? false);
			let strictFallbackErrorMessage: string | undefined;
			const cacheDiagnosticsKey = `${model.provider}\u0000${baseUrl}\u0000${model.id}\u0000${options?.sessionId ?? ""}`;
			let cacheDiagnosticsHash: string | undefined;
			const prepareParams = async (): Promise<MessageCreateParamsStreaming> => {
				let nextParams = buildParams(model, baseUrl, context, isOAuthToken, options, disableStrictTools);
				const replacementPayload = await options?.onPayload?.(nextParams, model);
				if (replacementPayload !== undefined) {
					nextParams = replacementPayload as typeof nextParams;
				}
				if (disableStrictTools) {
					dropAnthropicStrictTools(nextParams);
				}
				rawRequestDump = {
					provider: model.provider,
					api: output.api,
					model: model.id,
					method: "POST",
					url: `${baseUrl}/v1/messages${isOAuthToken ? "?beta=true" : ""}`,
					body: nextParams,
				};
				cacheDiagnosticsHash = computeAnthropicCacheDiagnosticsHash(nextParams, model);
				return nextParams;
			};
			let params = await prepareParams();

			type Block = (
				| ThinkingContent
				| RedactedThinkingContent
				| TextContent
				| (ToolCall & { partialJson: string })
			) & { index: number };
			const blocks = output.content as Block[];
			const firstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs();
			stream.push({ type: "start", partial: output });
			// Retry loop for transient errors from the stream.
			// Provider-level transport/rate-limit failures: only before any streamed content starts.
			// Malformed envelopes/JSON: only before replay-unsafe text/tool events are visible on this stream.
			let providerRetryAttempt = 0;
			while (true) {
				activeAbortTracker = createAbortSourceTracker(options?.signal);
				const firstEventTimeoutAbortError = new Error(
					"Anthropic stream timed out while waiting for the first event",
				);
				const { requestSignal } = activeAbortTracker;
				const anthropicRequest = isOAuthToken
					? client.beta.messages.create({ ...params, stream: true }, { signal: requestSignal })
					: client.messages.create({ ...params, stream: true }, { signal: requestSignal });
				let streamedReplayUnsafeContent = false;

				try {
					const {
						events: anthropicStream,
						response,
						requestId,
					} = await getAnthropicStreamResponse(anthropicRequest, requestSignal);
					await notifyProviderResponse(options, response, model, requestId);
					const firstEventWatchdog = createWatchdog(firstEventTimeoutMs, () =>
						activeAbortTracker.abortLocally(firstEventTimeoutAbortError),
					);
					let sawEvent = false;
					let sawMessageStart = false;
					let sawTerminalEnvelope = false;

					for await (const event of anthropicStream) {
						if (!sawEvent) {
							clearTimeout(firstEventWatchdog);
						}
						sawEvent = true;

						if (event.type === "message_start") {
							if (sawMessageStart) {
								continue;
							}
							sawMessageStart = true;
							applyAnthropicUsageExtras(output.usage, event.message.usage);
							output.responseId = event.message.id;
							output.usage.input = event.message.usage.input_tokens || 0;
							output.usage.output = event.message.usage.output_tokens || 0;
							output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
							output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
							output.usage.totalTokens =
								output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
							calculateCost(model, output.usage);
							recordAnthropicCacheDiagnostics({
								state: providerSessionState,
								key: cacheDiagnosticsKey,
								hash: cacheDiagnosticsHash,
								cacheReadTokens: output.usage.cacheRead,
								cacheCreationTokens: output.usage.cacheWrite,
								modelId: model.id,
							});
							continue;
						}

						if (!sawMessageStart) {
							if (shouldIgnoreAnthropicPreambleEvent(event.type)) {
								continue;
							}
							throw createAnthropicStreamEnvelopeError(`received ${event.type} before message_start`);
						}

						if (event.type === "content_block_start") {
							if (!firstTokenTime) firstTokenTime = Date.now();
							if (event.content_block.type === "text") {
								streamedReplayUnsafeContent = true;
								const block: Block = {
									type: "text",
									text: "",
									index: event.index,
								};
								output.content.push(block);
								stream.push({
									type: "text_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							} else if (event.content_block.type === "thinking") {
								const block: Block = {
									type: "thinking",
									thinking: "",
									thinkingSignature: "",
									index: event.index,
								};
								output.content.push(block);
								stream.push({
									type: "thinking_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							} else if (event.content_block.type === "redacted_thinking") {
								const block: Block = {
									type: "redactedThinking",
									data: event.content_block.data,
									index: event.index,
								};
								output.content.push(block);
							} else if (event.content_block.type === "tool_use") {
								streamedReplayUnsafeContent = true;
								const block: Block = {
									type: "toolCall",
									id: event.content_block.id,
									name: isOAuthToken
										? stripClaudeToolPrefix(event.content_block.name)
										: event.content_block.name,
									arguments: (event.content_block.input as Record<string, unknown>) ?? {},
									partialJson: "",
									index: event.index,
								};
								output.content.push(block);
								stream.push({
									type: "toolcall_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							}
						} else if (event.type === "content_block_delta") {
							if (event.delta.type === "text_delta") {
								const index = blocks.findIndex(b => b.index === event.index);
								const block = blocks[index];
								if (block && block.type === "text") {
									block.text += event.delta.text;
									stream.push({
										type: "text_delta",
										contentIndex: index,
										delta: event.delta.text,
										partial: output,
									});
								}
							} else if (event.delta.type === "thinking_delta") {
								const index = blocks.findIndex(b => b.index === event.index);
								const block = blocks[index];
								if (block && block.type === "thinking") {
									block.thinking += event.delta.thinking;
									stream.push({
										type: "thinking_delta",
										contentIndex: index,
										delta: event.delta.thinking,
										partial: output,
									});
								}
							} else if (event.delta.type === "input_json_delta") {
								const index = blocks.findIndex(b => b.index === event.index);
								const block = blocks[index];
								if (block && block.type === "toolCall") {
									block.partialJson += event.delta.partial_json;
									block.arguments = parseStreamingJson(block.partialJson);
									stream.push({
										type: "toolcall_delta",
										contentIndex: index,
										delta: event.delta.partial_json,
										partial: output,
									});
								}
							} else if (event.delta.type === "signature_delta") {
								const index = blocks.findIndex(b => b.index === event.index);
								const block = blocks[index];
								if (block && block.type === "thinking") {
									block.thinkingSignature = block.thinkingSignature || "";
									block.thinkingSignature += event.delta.signature;
								}
							}
						} else if (event.type === "content_block_stop") {
							const index = blocks.findIndex(b => b.index === event.index);
							const block = blocks[index];
							if (block) {
								delete (block as { index?: number }).index;
								if (block.type === "text") {
									stream.push({
										type: "text_end",
										contentIndex: index,
										content: block.text,
										partial: output,
									});
								} else if (block.type === "thinking") {
									stream.push({
										type: "thinking_end",
										contentIndex: index,
										content: block.thinking,
										partial: output,
									});
								} else if (block.type === "toolCall") {
									block.arguments = parseStreamingJson(block.partialJson);
									delete (block as { partialJson?: string }).partialJson;
									stream.push({
										type: "toolcall_end",
										contentIndex: index,
										toolCall: block,
										partial: output,
									});
								}
							}
						} else if (event.type === "message_delta") {
							if (event.delta.stop_reason) {
								output.stopReason = mapStopReason(event.delta.stop_reason);
								sawTerminalEnvelope = true;
							}
							if (event.usage.input_tokens != null) {
								output.usage.input = event.usage.input_tokens;
							}
							if (event.usage.output_tokens != null) {
								output.usage.output = event.usage.output_tokens;
							}
							if (event.usage.cache_read_input_tokens != null) {
								output.usage.cacheRead = event.usage.cache_read_input_tokens;
							}
							if (event.usage.cache_creation_input_tokens != null) {
								output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
							}
							applyAnthropicUsageExtras(output.usage, event.usage);
							output.usage.totalTokens =
								output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
							calculateCost(model, output.usage);
						} else if (event.type === "message_stop") {
							sawTerminalEnvelope = true;
						}
					}

					const firstEventTimeoutError = activeAbortTracker.getLocalAbortReason();
					if (firstEventTimeoutError) {
						throw firstEventTimeoutError;
					}
					if (activeAbortTracker.wasCallerAbort()) {
						throw new Error("Request was aborted");
					}
					if (!sawEvent || !sawMessageStart) {
						throw createAnthropicStreamEnvelopeError("stream ended before message_start");
					}
					if (!sawTerminalEnvelope) {
						throw createAnthropicStreamEnvelopeError("stream ended before terminal stop signal");
					}

					if (output.stopReason === "aborted" || output.stopReason === "error") {
						throw new Error("An unknown error occurred");
					}
					break;
				} catch (streamError) {
					const streamFailure = activeAbortTracker.getLocalAbortReason() ?? streamError;
					if (
						!disableStrictTools &&
						firstTokenTime === undefined &&
						hasStrictAnthropicTools(params) &&
						isAnthropicStrictGrammarTooLargeError(streamFailure)
					) {
						strictFallbackErrorMessage = await finalizeErrorMessage(streamFailure, rawRequestDump);
						output.errorMessage = strictFallbackErrorMessage;
						if (providerSessionState) {
							providerSessionState.strictToolsDisabled = true;
						}
						disableStrictTools = true;
						params = await prepareParams();
						providerRetryAttempt = 0;
						output.content.length = 0;
						output.responseId = undefined;
						output.providerPayload = undefined;
						output.usage = createEmptyUsage(copilotDynamicHeaders?.premiumRequests);
						output.stopReason = "stop";
						firstTokenTime = undefined;
						continue;
					}
					const isTransientEnvelopeFailure =
						isTransientStreamParseError(streamFailure) || isTransientStreamEnvelopeError(streamFailure);
					const canRetryTransientEnvelopeFailure = isTransientEnvelopeFailure && !streamedReplayUnsafeContent;
					const canRetryProviderFailure =
						firstTokenTime === undefined && isProviderRetryableError(streamFailure, model.provider);
					if (
						activeAbortTracker.wasCallerAbort() ||
						providerRetryAttempt >= PROVIDER_MAX_RETRIES ||
						(!canRetryTransientEnvelopeFailure && !canRetryProviderFailure)
					) {
						throw streamFailure;
					}
					providerRetryAttempt++;
					const delayMs = PROVIDER_BASE_DELAY_MS * 2 ** (providerRetryAttempt - 1);
					await abortableSleep(delayMs, options?.signal);
					output.content.length = 0;
					output.responseId = undefined;
					output.errorMessage = strictFallbackErrorMessage;
					output.providerPayload = undefined;
					output.usage = createEmptyUsage(copilotDynamicHeaders?.premiumRequests);
					output.stopReason = "stop";
					firstTokenTime = undefined;
				}
			}

			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				delete (block as { partialJson?: string }).partialJson;
			}
			const firstEventTimeoutError = activeAbortTracker.getLocalAbortReason();
			output.stopReason = activeAbortTracker.wasCallerAbort() ? "aborted" : "error";
			output.errorMessage = firstEventTimeoutError?.message ?? (await finalizeErrorMessage(error, rawRequestDump));
			output.errorMessage = rewriteCopilotError(output.errorMessage, error, model.provider);
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export type AnthropicSystemBlock = {
	type: "text";
	text: string;
	cache_control?: AnthropicCacheControl;
};
type SystemBlockOptions = {
	includeClaudeCodeInstruction?: boolean;
	extraInstructions?: string[];
	billingPayload?: unknown;
	cacheControl?: AnthropicCacheControl;
	cachePolicy?: AnthropicCachePolicy;
};

type AnthropicSystemBlockPlan = {
	text: string;
	cacheScope: AnthropicCacheScope | null;
};

function createSystemBlockFromPlan(plan: AnthropicSystemBlockPlan, policy: AnthropicCachePolicy): AnthropicSystemBlock {
	const cacheControl = plan.cacheScope === null ? undefined : createCacheControl(policy, plan.cacheScope);
	return {
		type: "text",
		text: plan.text,
		...(cacheControl && { cache_control: cacheControl }),
	};
}

const CLAUDE_AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX =
	"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
const CLAUDE_AGENT_SDK_PREFIX = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_CODE_SYSTEM_PROMPT_PREFIXES = new Set([
	claudeCodeSystemInstruction,
	CLAUDE_AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX,
	CLAUDE_AGENT_SDK_PREFIX,
]);

function splitClaudeCodeSystemPromptBlocks(
	systemPrompt: readonly string[],
	policy: AnthropicCachePolicy,
): AnthropicSystemBlockPlan[] {
	const useGlobalCacheFeature = policy.useGlobalSystemCache;
	if (useGlobalCacheFeature && policy.skipGlobalCacheForSystemPrompt) {
		let attributionHeader: string | undefined;
		let systemPromptPrefix: string | undefined;
		const rest: string[] = [];

		for (const prompt of systemPrompt) {
			if (!prompt || prompt === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) continue;
			if (prompt.startsWith(CLAUDE_BILLING_HEADER_PREFIX)) {
				attributionHeader = prompt;
			} else if (CLAUDE_CODE_SYSTEM_PROMPT_PREFIXES.has(prompt)) {
				systemPromptPrefix = prompt;
			} else {
				rest.push(prompt);
			}
		}

		const result: AnthropicSystemBlockPlan[] = [];
		if (attributionHeader) result.push({ text: attributionHeader, cacheScope: null });
		if (systemPromptPrefix) result.push({ text: systemPromptPrefix, cacheScope: "org" });
		const restJoined = rest.join("\n\n");
		if (restJoined) result.push({ text: restJoined, cacheScope: "org" });
		return result;
	}

	if (useGlobalCacheFeature) {
		const boundaryIndex = systemPrompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
		if (boundaryIndex !== -1) {
			let attributionHeader: string | undefined;
			let systemPromptPrefix: string | undefined;
			const staticBlocks: string[] = [];
			const dynamicBlocks: string[] = [];

			for (let index = 0; index < systemPrompt.length; index++) {
				const block = systemPrompt[index];
				if (!block || block === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) continue;

				if (block.startsWith(CLAUDE_BILLING_HEADER_PREFIX)) {
					attributionHeader = block;
				} else if (CLAUDE_CODE_SYSTEM_PROMPT_PREFIXES.has(block)) {
					systemPromptPrefix = block;
				} else if (index < boundaryIndex) {
					staticBlocks.push(block);
				} else {
					dynamicBlocks.push(block);
				}
			}

			const result: AnthropicSystemBlockPlan[] = [];
			if (attributionHeader) result.push({ text: attributionHeader, cacheScope: null });
			if (systemPromptPrefix) result.push({ text: systemPromptPrefix, cacheScope: null });
			const staticJoined = staticBlocks.join("\n\n");
			if (staticJoined) result.push({ text: staticJoined, cacheScope: "global" });
			const dynamicJoined = dynamicBlocks.join("\n\n");
			if (dynamicJoined) result.push({ text: dynamicJoined, cacheScope: null });
			return result;
		}
	}

	let attributionHeader: string | undefined;
	let systemPromptPrefix: string | undefined;
	const rest: string[] = [];
	for (const block of systemPrompt) {
		if (!block) continue;
		if (block.startsWith(CLAUDE_BILLING_HEADER_PREFIX)) {
			attributionHeader = block;
		} else if (CLAUDE_CODE_SYSTEM_PROMPT_PREFIXES.has(block)) {
			systemPromptPrefix = block;
		} else {
			rest.push(block);
		}
	}

	const result: AnthropicSystemBlockPlan[] = [];
	if (attributionHeader) result.push({ text: attributionHeader, cacheScope: null });
	if (systemPromptPrefix) result.push({ text: systemPromptPrefix, cacheScope: "org" });
	const restJoined = rest.join("\n\n");
	if (restJoined) result.push({ text: restJoined, cacheScope: "org" });
	return result;
}

function buildClaudeCodeAlignedSystemBlocks(
	prompts: readonly string[],
	options: {
		includeClaudeCodeInstruction: boolean;
		extraInstructions: readonly string[];
		billingPayload?: unknown;
		cachePolicy: AnthropicCachePolicy;
	},
): AnthropicSystemBlock[] | undefined {
	const { includeClaudeCodeInstruction, extraInstructions, billingPayload, cachePolicy } = options;
	const sanitizedPrompts = normalizeSystemPrompts(prompts);
	const trimmedInstructions = extraInstructions.map(instruction => instruction.trim()).filter(Boolean);
	const hasBillingBlock = sanitizedPrompts.some(block => block.startsWith(CLAUDE_BILLING_HEADER_PREFIX));
	const hasSystemPromptPrefix = sanitizedPrompts.some(block => CLAUDE_CODE_SYSTEM_PROMPT_PREFIXES.has(block));
	const payloadSeed = billingPayload ?? {
		system: sanitizedPrompts,
		extraInstructions: trimmedInstructions,
	};
	const systemPromptForSplit = [
		includeClaudeCodeInstruction && !hasBillingBlock ? createClaudeBillingHeader(payloadSeed) : undefined,
		includeClaudeCodeInstruction && !hasSystemPromptPrefix ? claudeCodeSystemInstruction : undefined,
		...trimmedInstructions,
		...sanitizedPrompts,
	].filter((block): block is string => typeof block === "string" && block.length > 0);
	const plans = splitClaudeCodeSystemPromptBlocks(systemPromptForSplit, cachePolicy);
	return plans.length > 0 ? plans.map(plan => createSystemBlockFromPlan(plan, cachePolicy)) : undefined;
}

export function buildAnthropicSystemBlocks(
	systemPrompt: readonly string[] | undefined,
	options: SystemBlockOptions = {},
): AnthropicSystemBlock[] | undefined {
	const {
		includeClaudeCodeInstruction = false,
		extraInstructions = [],
		billingPayload,
		cacheControl,
		cachePolicy,
	} = options;
	if (cachePolicy) {
		return buildClaudeCodeAlignedSystemBlocks(systemPrompt ?? [], {
			includeClaudeCodeInstruction,
			extraInstructions,
			billingPayload,
			cachePolicy,
		});
	}
	if (cacheControl) {
		return buildClaudeCodeAlignedSystemBlocks(systemPrompt ?? [], {
			includeClaudeCodeInstruction,
			extraInstructions,
			billingPayload,
			cachePolicy: {
				enabled: true,
				retention: cacheControl.ttl === "1h" ? "long" : "short",
				...(cacheControl.ttl === "1h" ? { ttl: "1h" as const } : {}),
				supportsScope: cacheControl.scope === "global",
				useGlobalSystemCache: cacheControl.scope === "global",
				skipGlobalCacheForSystemPrompt: false,
			},
		});
	}

	const blocks: AnthropicSystemBlock[] = [];
	const sanitizedPrompts = normalizeSystemPrompts(systemPrompt);
	const trimmedInstructions = extraInstructions.map(instruction => instruction.trim()).filter(Boolean);
	const hasBillingHeader = sanitizedPrompts.some(prompt => prompt.includes(CLAUDE_BILLING_HEADER_PREFIX));

	if (includeClaudeCodeInstruction && !hasBillingHeader) {
		const payloadSeed = billingPayload ?? {
			system: sanitizedPrompts,
			extraInstructions: trimmedInstructions,
		};
		blocks.push(
			{ type: "text", text: createClaudeBillingHeader(payloadSeed) },
			{
				type: "text",
				text: claudeCodeSystemInstruction,
			},
		);
	}

	for (const instruction of trimmedInstructions) {
		blocks.push({ type: "text", text: instruction });
	}

	for (const promptBlock of sanitizedPrompts) {
		if (promptBlock === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) continue;
		blocks.push({ type: "text", text: promptBlock });
	}

	return blocks.length > 0 ? blocks : undefined;
}

export function normalizeExtraBetas(betas?: string[] | string): string[] {
	if (!betas) return [];
	const raw = Array.isArray(betas) ? betas : betas.split(",");
	return raw.map(beta => beta.trim()).filter(beta => beta.length > 0);
}

export function buildAnthropicClientOptions(args: AnthropicClientOptionsArgs): AnthropicClientOptionsResult {
	const {
		model,
		apiKey,
		extraBetas = [],
		stream = true,
		interleavedThinking = true,
		headers,
		dynamicHeaders,
		hasTools = false,
		isOAuth,
	} = args;
	const compat = getAnthropicCompat(model);
	const needsInterleavedBeta = interleavedThinking && !supportsAdaptiveThinkingDisplay(model.id);
	const needsFineGrainedToolStreamingBeta = hasTools && !compat.supportsEagerToolInputStreaming;
	const oauthToken = isOAuth ?? isAnthropicOAuthToken(apiKey);
	const baseUrl = resolveAnthropicBaseUrl(model, apiKey);
	const foundryCustomHeaders = resolveAnthropicCustomHeaders(model);
	const tlsFetchOptions = buildClaudeCodeTlsFetchOptions(model, baseUrl);
	if (model.provider === "github-copilot") {
		const copilotApiKey = parseGitHubCopilotApiKey(apiKey).accessToken;
		const betaFeatures = [...extraBetas];
		if (needsFineGrainedToolStreamingBeta) {
			betaFeatures.push(fineGrainedToolStreamingBeta);
		}
		const defaultHeaders = mergeHeaders(
			{
				Accept: stream ? "text/event-stream" : "application/json",
				"Anthropic-Dangerous-Direct-Browser-Access": "true",
				Authorization: `Bearer ${copilotApiKey}`,
				...(betaFeatures.length > 0 ? { "anthropic-beta": buildBetaHeader([], betaFeatures) } : {}),
			},
			model.headers,
			dynamicHeaders,
			headers,
		);

		return {
			isOAuthToken: false,
			apiKey: null,
			authToken: copilotApiKey,
			baseURL: baseUrl,
			maxRetries: 5,
			dangerouslyAllowBrowser: true,
			defaultHeaders,
			logLevel: ANTHROPIC_SDK_LOG_LEVEL,
			...(tlsFetchOptions ? { fetchOptions: tlsFetchOptions } : {}),
		};
	}

	const betaFeatures = [...extraBetas];
	if (needsFineGrainedToolStreamingBeta) {
		betaFeatures.push(fineGrainedToolStreamingBeta);
	}
	if (needsInterleavedBeta) {
		betaFeatures.push(interleavedThinkingBeta);
	}

	const defaultHeaders = buildAnthropicHeaders({
		apiKey,
		baseUrl,
		isOAuth: oauthToken,
		extraBetas: betaFeatures,
		stream,
		modelHeaders: mergeHeaders(model.headers, foundryCustomHeaders, headers, dynamicHeaders),
		isCloudflareAiGateway: model.provider === "cloudflare-ai-gateway",
		modelId: model.id,
		sessionId: args.sessionId,
	});

	if (model.provider === "cloudflare-ai-gateway") {
		return {
			isOAuthToken: false,
			apiKey: null,
			authToken: null,
			baseURL: baseUrl,
			maxRetries: 5,
			dangerouslyAllowBrowser: true,
			defaultHeaders,
			logLevel: ANTHROPIC_SDK_LOG_LEVEL,
		};
	}

	return {
		isOAuthToken: oauthToken,
		apiKey: oauthToken ? null : apiKey,
		authToken: oauthToken ? apiKey : undefined,
		baseURL: baseUrl,
		maxRetries: 5,
		dangerouslyAllowBrowser: true,
		defaultHeaders,
		logLevel: ANTHROPIC_SDK_LOG_LEVEL,
		...(tlsFetchOptions ? { fetchOptions: tlsFetchOptions } : {}),
	};
}

function createClient(
	model: Model<"anthropic-messages">,
	args: AnthropicClientOptionsArgs,
): { client: Anthropic; isOAuthToken: boolean } {
	const { isOAuthToken: oauthToken, ...clientOptions } = buildAnthropicClientOptions({ ...args, model });
	const client = new Anthropic(clientOptions);
	return { client, isOAuthToken: oauthToken };
}

function disableThinkingIfToolChoiceForced(params: MessageCreateParamsStreaming): void {
	const toolChoice = params.tool_choice;
	if (!toolChoice) return;
	if (toolChoice.type === "any" || toolChoice.type === "tool") {
		delete params.thinking;
		delete params.output_config;
	}
}

function ensureMaxTokensForThinking(params: MessageCreateParamsStreaming, model: Model<"anthropic-messages">): void {
	const thinking = params.thinking;
	if (!thinking || thinking.type !== "enabled") return;

	const budgetTokens = thinking.budget_tokens ?? 0;
	if (budgetTokens <= 0) return;

	const maxTokens = params.max_tokens ?? 0;
	const requiredMaxTokens = budgetTokens + OUTPUT_FALLBACK_BUFFER;
	if (maxTokens < requiredMaxTokens) {
		params.max_tokens = Math.min(requiredMaxTokens, model.maxTokens);
	}
}

type CacheControlBlock = {
	cache_control?: AnthropicCacheControl | null;
};

type CacheReferenceBlock = {
	type?: string;
	tool_use_id?: string;
	cache_reference?: string;
};

function isToolResultCacheReferenceBlock(block: unknown): block is CacheReferenceBlock & { tool_use_id: string } {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as CacheReferenceBlock).type === "tool_result" &&
		typeof (block as CacheReferenceBlock).tool_use_id === "string"
	);
}

function insertBlockAfterToolResults(content: unknown[], block: unknown): void {
	let lastToolResultIndex = -1;
	for (let index = 0; index < content.length; index++) {
		if (isToolResultCacheReferenceBlock(content[index])) {
			lastToolResultIndex = index;
		}
	}

	if (lastToolResultIndex >= 0) {
		const insertPosition = lastToolResultIndex + 1;
		content.splice(insertPosition, 0, block);
		if (insertPosition === content.length - 1) {
			content.push({ type: "text", text: "." });
		}
		return;
	}

	const insertIndex = Math.max(0, content.length - 1);
	content.splice(insertIndex, 0, block);
}

function deduplicateCacheEditsBlock(
	block: AnthropicCacheEditsBlock,
	seenDeleteRefs: Set<string>,
): AnthropicCacheEditsBlock {
	const edits = block.edits.filter(edit => {
		if (seenDeleteRefs.has(edit.cache_reference)) return false;
		seenDeleteRefs.add(edit.cache_reference);
		return true;
	});
	return { ...block, edits };
}

function ensureUserMessageContentArray(message: MessageParam): unknown[] {
	if (!Array.isArray(message.content)) {
		message.content = [{ type: "text", text: message.content as string }] as ContentBlockParam[];
	}
	return message.content as unknown[];
}

function findLastMessageCacheControlIndex(params: MessageCreateParamsStreaming): number {
	let lastCacheControlMessageIndex = -1;
	for (let index = 0; index < params.messages.length; index++) {
		const message = params.messages[index];
		if (!Array.isArray(message.content)) continue;
		if (
			(message.content as Array<ContentBlockParam & CacheControlBlock>).some(block => block.cache_control != null)
		) {
			lastCacheControlMessageIndex = index;
		}
	}
	return lastCacheControlMessageIndex;
}

function applyCachedMicrocompactBreakpoints(
	params: MessageCreateParamsStreaming,
	options: {
		enablePromptCaching: boolean;
		useCachedMicrocompact: boolean;
		newCacheEdits?: AnthropicCacheEditsBlock | null;
		pinnedCacheEdits?: AnthropicPinnedCacheEdits[];
		onPinCacheEdits?: (userMessageIndex: number, block: AnthropicCacheEditsBlock) => void;
	},
): void {
	if (!options.useCachedMicrocompact) return;

	const seenDeleteRefs = new Set<string>();
	for (const pinned of options.pinnedCacheEdits ?? []) {
		const message = params.messages[pinned.userMessageIndex];
		if (!message || message.role !== "user") continue;
		const dedupedBlock = deduplicateCacheEditsBlock(pinned.block, seenDeleteRefs);
		if (dedupedBlock.edits.length > 0) {
			insertBlockAfterToolResults(ensureUserMessageContentArray(message), dedupedBlock);
		}
	}

	const newCacheEdits = options.newCacheEdits;
	if (newCacheEdits && params.messages.length > 0) {
		const dedupedNewEdits = deduplicateCacheEditsBlock(newCacheEdits, seenDeleteRefs);
		if (dedupedNewEdits.edits.length > 0) {
			for (let index = params.messages.length - 1; index >= 0; index--) {
				const message = params.messages[index];
				if (!message || message.role !== "user") continue;
				insertBlockAfterToolResults(ensureUserMessageContentArray(message), dedupedNewEdits);
				options.onPinCacheEdits?.(index, newCacheEdits);
				break;
			}
		}
	}

	if (!options.enablePromptCaching) return;
	const lastCacheControlMessageIndex = findLastMessageCacheControlIndex(params);
	if (lastCacheControlMessageIndex < 0) return;
	for (let messageIndex = 0; messageIndex < lastCacheControlMessageIndex; messageIndex++) {
		const message = params.messages[messageIndex];
		if (message.role !== "user" || !Array.isArray(message.content)) continue;
		let cloned = false;
		for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
			const block = message.content[blockIndex];
			if (!isToolResultCacheReferenceBlock(block)) continue;
			if (!cloned) {
				message.content = [...message.content];
				cloned = true;
			}
			message.content[blockIndex] = {
				...(block as unknown as Record<string, unknown>),
				cache_reference: block.tool_use_id,
			} as unknown as ContentBlockParam;
		}
	}
}

function findCacheableMessageBlockIndex(message: MessageParam): number {
	if (!Array.isArray(message.content) || message.content.length === 0) return -1;
	const blockIndex = message.content.length - 1;
	const block = message.content[blockIndex];
	if (!block) return -1;
	if (message.role === "assistant" && (block.type === "thinking" || block.type === "redacted_thinking")) {
		return -1;
	}
	return blockIndex;
}

function applyCacheControlToMessage(message: MessageParam, cacheControl: AnthropicCacheControl): boolean {
	if (typeof message.content === "string") {
		message.content = [{ type: "text", text: message.content, cache_control: cacheControl }];
		return true;
	}
	if (!Array.isArray(message.content) || message.content.length === 0) return false;
	const blockIndex = findCacheableMessageBlockIndex(message);
	if (blockIndex < 0) return false;
	const content = [...message.content];
	const block = content[blockIndex];
	if (!block) return false;
	content[blockIndex] = { ...block, cache_control: cacheControl } as ContentBlockParam & CacheControlBlock;
	message.content = content;
	return true;
}

function applyPromptCaching(
	params: MessageCreateParamsStreaming,
	cacheControl: AnthropicCacheControl | undefined,
	skipCacheWrite = false,
): void {
	if (!cacheControl || params.messages.length === 0) return;
	const markerIndex = skipCacheWrite ? params.messages.length - 2 : params.messages.length - 1;
	if (markerIndex < 0) return;
	const markerMessage = params.messages[markerIndex];
	if (!markerMessage) return;
	applyCacheControlToMessage(markerMessage, cacheControl);
}

function normalizeCacheControlBlockTtl(block: CacheControlBlock, seenFiveMinute: { value: boolean }): void {
	const cacheControl = block.cache_control;
	if (!cacheControl) return;
	if (cacheControl.ttl !== "1h") {
		seenFiveMinute.value = true;
		return;
	}
	if (seenFiveMinute.value) {
		delete cacheControl.ttl;
	}
}

function normalizeCacheControlTtlOrdering(params: MessageCreateParamsStreaming): void {
	const seenFiveMinute = { value: false };
	if (params.tools) {
		for (const tool of params.tools as Array<Anthropic.Messages.Tool & CacheControlBlock>) {
			normalizeCacheControlBlockTtl(tool, seenFiveMinute);
		}
	}
	if (params.system && Array.isArray(params.system)) {
		for (const block of params.system as Array<AnthropicSystemBlock & CacheControlBlock>) {
			normalizeCacheControlBlockTtl(block, seenFiveMinute);
		}
	}
	for (const message of params.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as Array<ContentBlockParam & CacheControlBlock>) {
			normalizeCacheControlBlockTtl(block, seenFiveMinute);
		}
	}
}

type CacheControlLocation = {
	block: CacheControlBlock;
	priority: number;
	order: number;
	label: string;
};

function cacheControlPriority(cacheControl: AnthropicCacheControl | null | undefined, label: string): number {
	if (!cacheControl) return 0;
	if (label === "system" && cacheControl.scope === "global") return 100;
	if (label === "system") return 90;
	if (label === "message") return 80;
	if (label === "tool") return 70;
	return 10;
}

function collectCacheControlLocations(params: MessageCreateParamsStreaming): CacheControlLocation[] {
	const locations: CacheControlLocation[] = [];
	let order = 0;
	if (params.tools) {
		for (const tool of params.tools as Array<Anthropic.Messages.Tool & CacheControlBlock>) {
			if (tool.cache_control) {
				locations.push({
					block: tool,
					priority: cacheControlPriority(tool.cache_control, "tool"),
					order,
					label: "tool",
				});
			}
			order++;
		}
	}
	if (params.system && Array.isArray(params.system)) {
		for (const block of params.system as Array<AnthropicSystemBlock & CacheControlBlock>) {
			if (block.cache_control) {
				locations.push({
					block,
					priority: cacheControlPriority(block.cache_control, "system"),
					order,
					label: "system",
				});
			}
			order++;
		}
	}
	for (const message of params.messages) {
		if (!Array.isArray(message.content)) {
			order++;
			continue;
		}
		for (const block of message.content as Array<ContentBlockParam & CacheControlBlock>) {
			if (block.cache_control) {
				locations.push({
					block,
					priority: cacheControlPriority(block.cache_control, "message"),
					order,
					label: "message",
				});
			}
			order++;
		}
	}
	return locations;
}

function enforceCacheControlLimit(params: MessageCreateParamsStreaming, maxBreakpoints: number): void {
	const locations = collectCacheControlLocations(params);
	if (locations.length <= maxBreakpoints) return;
	const toStrip = locations
		.sort((left, right) => left.priority - right.priority || left.order - right.order)
		.slice(0, locations.length - maxBreakpoints);
	for (const location of toStrip) {
		delete location.block.cache_control;
	}
	logger.debug("Stripped excess Anthropic cache_control breakpoints", {
		total: locations.length,
		maxBreakpoints,
		stripped: toStrip.map(location => location.label).join(","),
	});
}

function orderAnthropicRequestParams(params: AnthropicSamplingParams): MessageCreateParamsStreaming {
	const {
		model,
		messages,
		system,
		tools,
		tool_choice,
		metadata,
		max_tokens,
		thinking,
		temperature,
		top_p,
		top_k,
		output_config,
		stream,
		...rest
	} = params;
	const ordered: Partial<AnthropicSamplingParams> = { model, messages };
	if (system !== undefined) ordered.system = system;
	if (tools !== undefined) ordered.tools = tools;
	if (tool_choice !== undefined) ordered.tool_choice = tool_choice;
	if (metadata !== undefined) ordered.metadata = metadata;
	ordered.max_tokens = max_tokens;
	if (thinking !== undefined) ordered.thinking = thinking;
	if (temperature !== undefined) ordered.temperature = temperature;
	if (top_p !== undefined) ordered.top_p = top_p;
	if (top_k !== undefined) ordered.top_k = top_k;
	if (output_config !== undefined) ordered.output_config = output_config;
	Object.assign(ordered, rest);
	if (stream !== undefined) ordered.stream = stream;
	return ordered as AnthropicSamplingParams;
}

function isFirstPartyAnthropicRequest(model: Model<"anthropic-messages">, baseUrl: string): boolean {
	return model.provider === "anthropic" && isAnthropicApiBaseUrl(baseUrl);
}

function isAnthropicMcpTool(tool: Tool): boolean {
	const metadata = tool as Tool & { isMcp?: unknown; mcpServerName?: unknown };
	return metadata.isMcp === true || typeof metadata.mcpServerName === "string" || tool.name.startsWith("mcp__");
}

function isDeferredFromAnthropicRequest(tool: Tool): boolean {
	const metadata = tool as Tool & { deferLoading?: unknown; defer_loading?: unknown };
	return metadata.deferLoading === true || metadata.defer_loading === true;
}

function findToolCacheControlOverlayIndex(tools: Tool[]): number {
	for (let index = tools.length - 1; index >= 0; index--) {
		if (!isDeferredFromAnthropicRequest(tools[index]!)) return index;
	}
	return -1;
}

function modelSupportsToolReference(modelId: string): boolean {
	return !modelId.toLowerCase().includes("haiku");
}

function isToolSearchTool(tool: Tool): boolean {
	return tool.name === "search_tool_bm25";
}

function hasDeferredAnthropicTools(tools: Tool[] | undefined): boolean {
	return tools?.some(isDeferredFromAnthropicRequest) ?? false;
}

function parseAutoToolSearchPercentage(value: string): number | null {
	if (!value.startsWith("auto:")) return null;
	const parsed = Number.parseInt(value.slice(5), 10);
	if (!Number.isFinite(parsed)) return null;
	return Math.max(0, Math.min(100, parsed));
}

function getAutoToolSearchPercentage(value: string | undefined): number {
	if (!value || value === "auto") return defaultAutoToolSearchPercentage;
	return parseAutoToolSearchPercentage(value) ?? defaultAutoToolSearchPercentage;
}

function getToolSearchMode(value: string | undefined): "standard" | "auto" | "enabled" {
	const autoPercentage = value ? parseAutoToolSearchPercentage(value) : null;
	if (autoPercentage === 0) return "enabled";
	if (autoPercentage === 100) return "standard";
	if (value === "auto" || (value?.startsWith("auto:") ?? false)) return "auto";
	if (isEnvTruthy(value)) return "enabled";
	if (value !== undefined) return "standard";
	return "enabled";
}

function estimateDeferredToolSearchChars(tools: Tool[]): number {
	let total = 0;
	for (const tool of tools) {
		if (!isDeferredFromAnthropicRequest(tool)) continue;
		total += tool.name.length;
		total += (tool.description ?? "").length;
		try {
			total += JSON.stringify(tool.parameters ?? {}).length;
		} catch {
			total += String(tool.parameters ?? "").length;
		}
	}
	return total;
}

function passesAutoToolSearchThreshold(
	model: Model<"anthropic-messages">,
	tools: Tool[],
	configuredMode: string | undefined,
): boolean {
	const percentage = getAutoToolSearchPercentage(configuredMode) / 100;
	const charThreshold = Math.floor(model.contextWindow * percentage * toolSearchCharsPerToken);
	return estimateDeferredToolSearchChars(tools) >= charThreshold;
}

function shouldUseAnthropicToolSearch(
	model: Model<"anthropic-messages">,
	baseUrl: string,
	tools: Tool[] | undefined,
): boolean {
	if (!tools || !hasDeferredAnthropicTools(tools)) return false;
	if (isEnvTruthy($env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) return false;
	if (!modelSupportsToolReference(model.id)) return false;
	if (!tools.some(isToolSearchTool)) return false;
	const configuredMode = $env.ENABLE_TOOL_SEARCH;
	const mode = getToolSearchMode(configuredMode);
	if (mode === "standard") return false;
	if (
		model.provider === "anthropic" &&
		!isAnthropicApiBaseUrl(baseUrl) &&
		!isEnvTruthy(configuredMode) &&
		mode !== "enabled"
	) {
		return false;
	}
	if (mode === "auto" && !passesAutoToolSearchThreshold(model, tools, configuredMode)) return false;
	return true;
}

function extractDiscoveredToolReferenceNames(messages: Message[]): Set<string> {
	const discovered = new Set<string>();
	for (const message of messages) {
		const providerPayload = "providerPayload" in message ? message.providerPayload : undefined;
		if (providerPayload?.type === "anthropicDiscoveredTools") {
			for (const toolName of providerPayload.toolNames) {
				discovered.add(toolName);
			}
		}
		if (message.role !== "toolResult") continue;
		for (const block of message.content) {
			if (block.type === "text" && typeof block.toolReferenceName === "string") {
				discovered.add(block.toolReferenceName);
			}
		}
	}
	return discovered;
}

function filterToolsForAnthropicToolSearch(
	tools: Tool[] | undefined,
	messages: Message[],
	enabled: boolean,
): Tool[] | undefined {
	if (!tools) return undefined;
	if (!enabled) return tools;
	const discoveredToolNames = extractDiscoveredToolReferenceNames(messages);
	return tools.filter(tool => {
		if (!isDeferredFromAnthropicRequest(tool)) return true;
		if (isToolSearchTool(tool)) return true;
		return discoveredToolNames.has(tool.name);
	});
}

function buildDeferredToolsAnnouncement(tools: Tool[] | undefined, enabled: boolean): Message | undefined {
	if (!enabled || !tools) return undefined;
	const deferredToolNames = tools
		.filter(tool => isDeferredFromAnthropicRequest(tool) && !isToolSearchTool(tool))
		.map(tool => tool.name)
		.sort();
	if (deferredToolNames.length === 0) return undefined;
	return {
		role: "user",
		content: `<available-deferred-tools>\n${deferredToolNames.join("\n")}\n</available-deferred-tools>`,
		timestamp: Date.now(),
	};
}

function shouldSkipGlobalCacheForSystemPrompt(
	model: Model<"anthropic-messages">,
	baseUrl: string,
	tools: Tool[] | undefined,
	options: AnthropicOptions | undefined,
): boolean {
	if (options?.skipGlobalCacheForSystemPrompt !== undefined) return options.skipGlobalCacheForSystemPrompt;
	if (!isFirstPartyAnthropicRequest(model, baseUrl)) return false;
	if (isEnvTruthy($env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) return false;
	return tools?.some(tool => isAnthropicMcpTool(tool) && !isDeferredFromAnthropicRequest(tool)) ?? false;
}

function shouldUseCachedMicrocompact(
	model: Model<"anthropic-messages">,
	baseUrl: string,
	options: AnthropicOptions | undefined,
): boolean {
	return (
		options?.useCachedMicrocompact === true &&
		isFirstPartyAnthropicRequest(model, baseUrl) &&
		options.querySource === "repl_main_thread"
	);
}

function buildParams(
	model: Model<"anthropic-messages">,
	baseUrl: string,
	context: Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
	disableStrictTools = false,
): MessageCreateParamsStreaming {
	const useToolSearch = shouldUseAnthropicToolSearch(model, baseUrl, context.tools);
	const requestTools = filterToolsForAnthropicToolSearch(context.tools, context.messages, useToolSearch);
	const skipGlobalCacheForSystemPrompt = shouldSkipGlobalCacheForSystemPrompt(model, baseUrl, requestTools, options);
	const cachePolicy = getCachePolicy(model, baseUrl, {
		...options,
		skipGlobalCacheForSystemPrompt,
	});
	const availableToolNames = new Set(requestTools?.map(tool => tool.name) ?? []);
	const deferredToolsAnnouncement = buildDeferredToolsAnnouncement(context.tools, useToolSearch);
	const requestMessages = deferredToolsAnnouncement
		? [deferredToolsAnnouncement, ...context.messages]
		: context.messages;
	let params: AnthropicSamplingParams = {
		model: model.id,
		messages: convertAnthropicMessages(requestMessages, model, isOAuthToken, {
			toolSearchEnabled: useToolSearch,
			availableToolNames,
		}),
		max_tokens: options?.maxTokens || (model.maxTokens / 3) | 0,
		stream: true,
	};
	if (options?.temperature !== undefined && !options?.thinkingEnabled) {
		params.temperature = options.temperature;
	}

	if (options?.topP !== undefined) {
		params.top_p = options.topP;
	}
	if (options?.topK !== undefined) {
		params.top_k = options.topK;
	}

	// Opus 4.7+ rejects non-default sampling parameters with 400 error.
	if (hasOpus47ApiRestrictions(model.id)) {
		delete params.top_p;
		delete params.top_k;
		delete params.temperature;
	}

	if (requestTools) {
		params.tools = convertTools(
			requestTools,
			isOAuthToken,
			disableStrictTools || model.provider === "github-copilot",
			getAnthropicCompat(model).supportsEagerToolInputStreaming,
			skipGlobalCacheForSystemPrompt ? createCacheControl(cachePolicy) : undefined,
			useToolSearch,
		);
	}

	if (model.reasoning) {
		if (options?.thinkingEnabled) {
			const mode = model.thinking?.mode;
			const requestedEffort = options.reasoning;
			const effort =
				options.effort ??
				(requestedEffort ? mapEffortToAnthropicAdaptiveEffort(model, requestedEffort) : undefined);

			const compat = getAnthropicCompat(model);
			if (mode === "anthropic-adaptive" && !compat.disableAdaptiveThinking) {
				// Starting with Claude Opus 4.7, adaptive thinking content is omitted from the
				// response by default. Opt into summarized reasoning so thinking deltas keep
				// streaming with human-readable content for callers that rely on it.
				const adaptive: { type: "adaptive"; display?: AnthropicThinkingDisplay } = { type: "adaptive" };
				if (supportsAdaptiveThinkingDisplay(model.id)) {
					adaptive.display = options.thinkingDisplay ?? "summarized";
				}
				params.thinking = adaptive as typeof params.thinking;
				if (effort) {
					// SDK's OutputConfig.effort type is not yet widened to include the new "xhigh"
					// level introduced with Claude Opus 4.7. Cast until the SDK catches up.
					params.output_config = { effort } as typeof params.output_config;
				}
			} else {
				params.thinking = {
					type: "enabled",
					budget_tokens: options.thinkingBudgetTokens || 1024,
					display: options.thinkingDisplay ?? "summarized",
				} as typeof params.thinking;
				if (mode === "anthropic-budget-effort" && effort) {
					params.output_config = { effort } as typeof params.output_config;
				}
			}
		} else if (options?.thinkingEnabled === false) {
			params.thinking = { type: "disabled" };
		}
	}

	const metadataUserId = resolveAnthropicMetadataUserId(options?.metadata?.user_id, isOAuthToken, options?.sessionId);
	if (metadataUserId) {
		params.metadata = { user_id: metadataUserId };
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else if (isOAuthToken && options.toolChoice.name) {
			params.tool_choice = {
				...options.toolChoice,
				name: applyClaudeToolPrefix(options.toolChoice.name),
			};
		} else {
			params.tool_choice = options.toolChoice;
		}
	}

	const shouldInjectClaudeCodeInstruction = isOAuthToken && !model.id.startsWith("claude-3-5-haiku");
	const billingSystemPrompts = normalizeSystemPrompts(context.systemPrompt);
	const billingPayload = shouldInjectClaudeCodeInstruction
		? {
				...params,
				...(billingSystemPrompts.length > 0 ? { system: billingSystemPrompts } : {}),
			}
		: undefined;
	const systemBlocks = buildAnthropicSystemBlocks(context.systemPrompt, {
		includeClaudeCodeInstruction: shouldInjectClaudeCodeInstruction,
		billingPayload,
		cachePolicy,
	});
	if (systemBlocks) {
		params.system = systemBlocks;
	}
	disableThinkingIfToolChoiceForced(params);
	ensureMaxTokensForThinking(params, model);
	applyPromptCaching(params, createCacheControl(cachePolicy), options?.skipCacheWrite);
	enforceCacheControlLimit(params, 4);
	applyCachedMicrocompactBreakpoints(params, {
		enablePromptCaching: cachePolicy.enabled,
		useCachedMicrocompact: shouldUseCachedMicrocompact(model, baseUrl, options),
		newCacheEdits: options?.newCacheEdits,
		pinnedCacheEdits: options?.pinnedCacheEdits,
		onPinCacheEdits: options?.onPinCacheEdits,
	});
	normalizeCacheControlTtlOrdering(params);
	params = orderAnthropicRequestParams(params) as AnthropicSamplingParams;
	finalizeClaudeBillingHeaderCch(params);

	return params;
}

/**
 * Z.AI's Anthropic-compatible proxy at `api.z.ai/api/anthropic` deserializes
 * tool_result blocks into a Python class that accesses `.id`, even though
 * Anthropic's standard tool_result schema only carries `tool_use_id`. Detect
 * that endpoint so we can emit the non-standard alias for it without
 * polluting requests to api.anthropic.com or other compatible proxies.
 * See: https://github.com/can1357/oh-my-pi/issues/814
 */
function isZaiAnthropicEndpoint(model: Model<"anthropic-messages">): boolean {
	if (model.provider === "zai") return true;
	const baseUrl = model.baseUrl;
	if (!baseUrl) return false;
	try {
		return new URL(baseUrl).hostname.toLowerCase() === "api.z.ai";
	} catch {
		return false;
	}
}

/**
 * Returns true for providers whose Anthropic-compatible endpoints do NOT
 * implement signature-based thinking-chain integrity (DeepSeek, Z.AI, etc.).
 * For these providers, unsigned thinking blocks must be preserved as
 * `type: "thinking"` instead of being degraded to text.
 */
function isNonSigningAnthropicEndpoint(model: Model<"anthropic-messages">): boolean {
	// Known non-signing providers
	if (model.provider === "zai" || model.provider === "deepseek") return true;
	const baseUrl = model.baseUrl;
	if (!baseUrl) return false;
	try {
		const hostname = new URL(baseUrl).hostname.toLowerCase();
		return hostname === "api.deepseek.com" || hostname.endsWith(".deepseek.com");
	} catch {
		return false;
	}
}

function buildToolResultBlock(
	model: Model<"anthropic-messages">,
	msg: ToolResultMessage,
	isOAuthToken: boolean,
	options?: { toolSearchEnabled?: boolean; availableToolNames?: ReadonlySet<string> },
): ContentBlockParam {
	const block: ContentBlockParam = {
		type: "tool_result",
		tool_use_id: msg.toolCallId,
		content: convertContentBlocks(msg.content, isOAuthToken, options),
		is_error: msg.isError,
	};
	if (isZaiAnthropicEndpoint(model)) {
		// Z.AI workaround (issue #814): include `id` aliased to `tool_use_id`.
		(block as unknown as Record<string, unknown>).id = msg.toolCallId;
	}
	return block;
}

export function convertAnthropicMessages(
	messages: Message[],
	model: Model<"anthropic-messages">,
	isOAuthToken: boolean,
	options?: { toolSearchEnabled?: boolean; availableToolNames?: ReadonlySet<string> },
): MessageParam[] {
	const params: MessageParam[] = [];

	const transformedMessages = transformMessages(messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user" || msg.role === "developer") {
			if (!msg.content) continue;

			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: msg.content.toWellFormed(),
					});
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map(item => {
					if (item.type === "text") {
						return {
							type: "text",
							text: item.text.toWellFormed(),
						};
					}
					return {
						type: "image",
						source: {
							type: "base64",
							media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
							data: item.data,
						},
					};
				});
				let filteredBlocks = !model?.input.includes("image") ? blocks.filter(b => b.type !== "image") : blocks;
				filteredBlocks = filteredBlocks.filter(b => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];
			const hasSignedThinking = msg.content.some(
				block =>
					block.type === "thinking" && !!block.thinkingSignature && block.thinkingSignature.trim().length > 0,
			);

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: block.text.toWellFormed(),
					});
				} else if (block.type === "thinking") {
					if (hasSignedThinking) {
						if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
							if (block.thinking.trim().length === 0) continue;
							blocks.push({
								type: "text",
								text: block.thinking.toWellFormed(),
							});
							continue;
						}
						blocks.push({
							type: "thinking",
							thinking: block.thinking,
							signature: block.thinkingSignature,
						});
						continue;
					}
					if (block.thinking.trim().length === 0) continue;
					if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
						if (isNonSigningAnthropicEndpoint(model)) {
							blocks.push({
								type: "thinking",
								thinking: block.thinking.toWellFormed(),
								signature: "",
							});
						} else {
							blocks.push({
								type: "text",
								text: block.thinking.toWellFormed(),
							});
						}
					} else {
						blocks.push({
							type: "thinking",
							thinking: block.thinking.toWellFormed(),
							signature: block.thinkingSignature,
						});
					}
				} else if (block.type === "redactedThinking") {
					if (block.data.trim().length === 0) continue;
					blocks.push({
						type: "redacted_thinking",
						data: block.data,
					});
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: isOAuthToken ? applyClaudeToolPrefix(block.name) : block.name,
						input: block.arguments ?? {},
					});
				}
			}
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks,
			});
		} else if (msg.role === "toolResult") {
			// Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint
			const toolResults: ContentBlockParam[] = [];

			// Add the current tool result
			toolResults.push(buildToolResultBlock(model, msg, isOAuthToken, options));

			// Look ahead for consecutive toolResult messages
			let j = i + 1;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const nextMsg = transformedMessages[j] as ToolResultMessage; // We know it's a toolResult
				toolResults.push(buildToolResultBlock(model, nextMsg, isOAuthToken, options));
				j++;
			}

			// Skip the messages we've already processed
			i = j - 1;

			// Add a single user message with all tool results
			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	if (params.length > 0 && params[params.length - 1]?.role === "assistant") {
		params.push({ role: "user", content: "Continue." });
	}

	return params;
}

const ANTHROPIC_UNSUPPORTED_TOOL_SCHEMA_FIELDS = new Set(["maxItems", "patternProperties"]);
const ANTHROPIC_STRICT_TOOL_ALLOWLIST = new Set(["bash", "python", "edit", "find"]);
const MAX_ANTHROPIC_STRICT_TOOLS = 20;
const MAX_ANTHROPIC_STRICT_OPTIONAL_PARAMETERS = 24;
const MAX_ANTHROPIC_STRICT_UNION_PARAMETERS = 16;

/** `minItems` / `maxItems` apply to arrays; Anthropic rejects them on `type: "object"` (including `minItems: 0`/`1`). */
function isJsonSchemaArrayNode(schema: Record<string, unknown>): boolean {
	const t = schema.type;
	if (t === "array") return true;
	if (Array.isArray(t) && t.includes("array") && !t.includes("object")) return true;
	return false;
}

function isJsonSchemaObjectNode(schema: Record<string, unknown>): boolean {
	if (isJsonSchemaArrayNode(schema)) return false;
	if (schema.type === "object") return true;
	if (Array.isArray(schema.type) && schema.type.includes("object")) return true;
	if (isRecord(schema.properties)) return true;
	return false;
}

function normalizeAnthropicToolSchema(
	schema: unknown,
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>> = new WeakMap(),
): unknown {
	if (!isRecord(schema)) return schema;

	const cached = cache.get(schema);
	if (cached) return cached;

	const result = Object.fromEntries(
		Object.entries(schema).filter(([key]) => !ANTHROPIC_UNSUPPORTED_TOOL_SCHEMA_FIELDS.has(key)),
	);
	cache.set(schema, result);
	if (isJsonSchemaObjectNode(result)) {
		delete result.minItems;
	} else {
		const minItems = result.minItems;
		if (typeof minItems === "number" && minItems !== 0 && minItems !== 1) {
			delete result.minItems;
		}
	}

	const type = result.type;
	const canBeObject =
		type === "object" || (Array.isArray(type) && type.includes("object")) || isRecord(result.properties);
	if (canBeObject) {
		result.additionalProperties = false;
	}

	if (isRecord(result.properties)) {
		result.properties = Object.fromEntries(
			Object.entries(result.properties).map(([propertyName, propertySchema]) => [
				propertyName,
				normalizeAnthropicToolSchema(propertySchema, cache),
			]),
		);
	}

	if (Array.isArray(result.items)) {
		result.items = result.items.map(item => normalizeAnthropicToolSchema(item, cache));
	} else if (isRecord(result.items)) {
		result.items = normalizeAnthropicToolSchema(result.items, cache);
	}

	for (const key of COMBINATOR_KEYS) {
		const variants = result[key];
		if (Array.isArray(variants)) {
			result[key] = variants.map(variant => normalizeAnthropicToolSchema(variant, cache));
		}
	}

	for (const defsKey of ["$defs", "definitions"] as const) {
		const definitions = result[defsKey];
		if (!isRecord(definitions)) continue;
		result[defsKey] = Object.fromEntries(
			Object.entries(definitions).map(([definitionName, definitionSchema]) => [
				definitionName,
				normalizeAnthropicToolSchema(definitionSchema, cache),
			]),
		);
	}

	return result;
}

type AnthropicToolInputSchema = Anthropic.Messages.Tool["input_schema"];

type AnthropicToolSchemaPlan = {
	inputSchema: AnthropicToolInputSchema;
	strict: boolean;
};

type AnthropicStrictBudget = {
	optionalRemaining: number;
	unionRemaining: number;
	optionalCount: number;
	unionCount: number;
};

function hasAnthropicUnionType(schema: Record<string, unknown>): boolean {
	return Array.isArray(schema.type) || Array.isArray(schema.anyOf);
}

function hasNullVariant(schema: Record<string, unknown>): boolean {
	if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
	return Array.isArray(schema.anyOf) && schema.anyOf.some(variant => isRecord(variant) && variant.type === "null");
}

function makeAnthropicNullableSchema(schema: unknown, budget: AnthropicStrictBudget): unknown | undefined {
	if (isRecord(schema)) {
		if (hasNullVariant(schema)) return schema;
		if (Array.isArray(schema.anyOf)) {
			return { ...schema, anyOf: [...schema.anyOf, { type: "null" }] };
		}
		if (Array.isArray(schema.type)) {
			return { ...schema, type: [...schema.type, "null"] };
		}
	}

	if (budget.unionRemaining <= 0) return undefined;
	budget.unionRemaining--;
	budget.unionCount++;
	return { anyOf: [schema, { type: "null" }] };
}

function normalizeAnthropicStrictSchemaNode(
	schema: unknown,
	budget: AnthropicStrictBudget,
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>>,
): unknown | undefined {
	if (Array.isArray(schema)) {
		const result: unknown[] = [];
		for (const entry of schema) {
			const normalized = normalizeAnthropicStrictSchemaNode(entry, budget, cache);
			if (normalized === undefined) return undefined;
			result.push(normalized);
		}
		return result;
	}

	if (!isRecord(schema)) return schema;

	const cached = cache.get(schema);
	if (cached) return cached;

	const result: Record<string, unknown> = { ...schema };
	cache.set(schema, result);

	if (hasAnthropicUnionType(result)) {
		if (budget.unionRemaining <= 0) return undefined;
		budget.unionRemaining--;
		budget.unionCount++;
	}

	if (isRecord(result.properties)) {
		const originalRequired = new Set(
			Array.isArray(result.required)
				? result.required.filter((entry): entry is string => typeof entry === "string")
				: [],
		);
		const properties: Record<string, unknown> = {};
		const required: string[] = [];

		for (const [propertyName, propertySchema] of Object.entries(result.properties)) {
			const normalizedProperty = normalizeAnthropicStrictSchemaNode(propertySchema, budget, cache);
			if (normalizedProperty === undefined) return undefined;

			if (originalRequired.has(propertyName)) {
				properties[propertyName] = normalizedProperty;
				required.push(propertyName);
				continue;
			}

			if (budget.optionalRemaining > 0) {
				budget.optionalRemaining--;
				budget.optionalCount++;
				properties[propertyName] = normalizedProperty;
				continue;
			}

			const nullableProperty = makeAnthropicNullableSchema(normalizedProperty, budget);
			if (nullableProperty === undefined) return undefined;
			properties[propertyName] = nullableProperty;
			required.push(propertyName);
		}

		result.properties = properties;
		result.required = required;
	}

	if (Array.isArray(result.items)) {
		const items = normalizeAnthropicStrictSchemaNode(result.items, budget, cache);
		if (items === undefined) return undefined;
		result.items = items;
	} else if (isRecord(result.items)) {
		const items = normalizeAnthropicStrictSchemaNode(result.items, budget, cache);
		if (items === undefined) return undefined;
		result.items = items;
	}

	for (const key of COMBINATOR_KEYS) {
		const variants = result[key];
		if (!Array.isArray(variants)) continue;
		const normalizedVariants = normalizeAnthropicStrictSchemaNode(variants, budget, cache);
		if (normalizedVariants === undefined) return undefined;
		result[key] = normalizedVariants;
	}

	for (const defsKey of ["$defs", "definitions"] as const) {
		const definitions = result[defsKey];
		if (!isRecord(definitions)) continue;
		const normalizedDefinitions: Record<string, unknown> = {};
		for (const [definitionName, definitionSchema] of Object.entries(definitions)) {
			const normalizedDefinition = normalizeAnthropicStrictSchemaNode(definitionSchema, budget, cache);
			if (normalizedDefinition === undefined) return undefined;
			normalizedDefinitions[definitionName] = normalizedDefinition;
		}
		result[defsKey] = normalizedDefinitions;
	}

	return result;
}

function normalizeAnthropicStrictSchema(
	schema: Record<string, unknown>,
	optionalRemaining: number,
	unionRemaining: number,
): { schema: Record<string, unknown>; optionalCount: number; unionCount: number } | undefined {
	const budget: AnthropicStrictBudget = {
		optionalRemaining,
		unionRemaining,
		optionalCount: 0,
		unionCount: 0,
	};
	const normalized = normalizeAnthropicStrictSchemaNode(schema, budget, new WeakMap());
	if (!isRecord(normalized)) return undefined;
	return { schema: normalized, optionalCount: budget.optionalCount, unionCount: budget.unionCount };
}

function buildAnthropicBaseToolInputSchema(tool: Tool): Record<string, unknown> {
	const jsonSchema = tool.parameters as Record<string, unknown>;
	return normalizeAnthropicToolSchema({
		...jsonSchema,
		type: "object",
		properties: isRecord(jsonSchema.properties) ? jsonSchema.properties : {},
		required: Array.isArray(jsonSchema.required)
			? jsonSchema.required.filter((entry): entry is string => typeof entry === "string")
			: [],
	}) as Record<string, unknown>;
}

function buildAnthropicToolSchemaPlans(tools: Tool[], disableStrictTools = false): AnthropicToolSchemaPlan[] {
	const plans = tools.map(
		(tool): AnthropicToolSchemaPlan => ({
			inputSchema: buildAnthropicBaseToolInputSchema(tool) as AnthropicToolInputSchema,
			strict: false,
		}),
	);
	if (NO_STRICT || disableStrictTools) return plans;

	const candidateIndexes = tools.flatMap((tool, index) => {
		if (!ANTHROPIC_STRICT_TOOL_ALLOWLIST.has(tool.name)) return [];
		return tool.strict === false ? [] : [index];
	});

	let strictToolCount = 0;
	let strictOptionalParameterCount = 0;
	let strictUnionParameterCount = 0;
	for (const index of candidateIndexes) {
		if (strictToolCount >= MAX_ANTHROPIC_STRICT_TOOLS) break;

		const strictResult = normalizeAnthropicStrictSchema(
			plans[index].inputSchema as Record<string, unknown>,
			MAX_ANTHROPIC_STRICT_OPTIONAL_PARAMETERS - strictOptionalParameterCount,
			MAX_ANTHROPIC_STRICT_UNION_PARAMETERS - strictUnionParameterCount,
		);
		if (!strictResult) continue;

		plans[index] = {
			inputSchema: strictResult.schema as AnthropicToolInputSchema,
			strict: true,
		};
		strictToolCount++;
		strictOptionalParameterCount += strictResult.optionalCount;
		strictUnionParameterCount += strictResult.unionCount;
	}

	return plans;
}

function convertTools(
	tools: Tool[],
	isOAuthToken: boolean,
	disableStrictTools = false,
	supportsEagerToolInputStreaming = true,
	toolCacheControl?: AnthropicCacheControl,
	toolSearchEnabled = true,
): Anthropic.Messages.Tool[] {
	if (!tools) return [];
	const schemaPlans = buildAnthropicToolSchemaPlans(tools, disableStrictTools);
	const toolCacheControlOverlayIndex = toolCacheControl ? findToolCacheControlOverlayIndex(tools) : -1;

	return tools.map((tool, index) => {
		const plan = schemaPlans[index];
		const deferLoading = toolSearchEnabled && (tool.deferLoading === true || tool.defer_loading === true);
		const cacheControl =
			tool.cacheControl ??
			tool.cache_control ??
			(index === toolCacheControlOverlayIndex ? toolCacheControl : undefined);
		return {
			name: isOAuthToken ? applyClaudeToolPrefix(tool.name) : tool.name,
			description: tool.description || "",
			input_schema: plan.inputSchema,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			...(plan.strict ? { strict: true } : {}),
			...(deferLoading ? { defer_loading: true } : {}),
			...(cacheControl ? { cache_control: cacheControl } : {}),
		};
	});
}

function mapStopReason(reason: Anthropic.Messages.StopReason | string): StopReason {
	switch (reason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		case "refusal":
			return "error";
		case "pause_turn": // Stop is good enough -> resubmit
			return "stop";
		case "stop_sequence":
			return "stop"; // We don't supply stop sequences, so this should never happen
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return "error";
		default:
			// Handle unknown stop reasons gracefully (API may add new values)
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}
