import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import { Effort } from "@oh-my-pi/pi-ai";
import {
	applyClaudeToolPrefix,
	buildAnthropicClientOptions,
	buildAnthropicHeaders,
	buildAnthropicSystemBlocks,
	claudeCodeHeaders,
	claudeCodeSystemInstruction,
	claudeCodeVersion,
	computeClaudeCch,
	computeClaudeVersionSuffix,
	generateClaudeCloakingUserId,
	isClaudeCloakingUserId,
	mapStainlessArch,
	mapStainlessOs,
	SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
	streamAnthropic,
	stripClaudeToolPrefix,
} from "@oh-my-pi/pi-ai/providers/anthropic";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model, Tool } from "@oh-my-pi/pi-ai/types";
import type { TSchema } from "@sinclair/typebox";
import { withEnv } from "./helpers";

const ANTHROPIC_MODEL: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const CLOUDFLARE_ANTHROPIC_MODEL: Model<"anthropic-messages"> = {
	...ANTHROPIC_MODEL,
	id: "anthropic/claude-sonnet-4-5",
	name: "Claude Sonnet 4.5 via Cloudflare",
	provider: "cloudflare-ai-gateway",
	baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic",
};

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

type CaptureAnthropicOptions = {
	isOAuth?: boolean;
	metadata?: { user_id?: string };
	thinkingEnabled?: boolean;
	reasoning?: Effort;
	temperature?: number;
	topP?: number;
	topK?: number;
	sessionId?: string;
	cacheRetention?: "none" | "short" | "long";
	skipCacheWrite?: boolean;
	useCachedMicrocompact?: boolean;
	newCacheEdits?: {
		type: "cache_edits";
		edits: Array<{ type: "delete"; cache_reference: string }>;
	} | null;
	pinnedCacheEdits?: Array<{
		userMessageIndex: number;
		block: {
			type: "cache_edits";
			edits: Array<{ type: "delete"; cache_reference: string }>;
		};
	}>;
	onPinCacheEdits?: (
		userMessageIndex: number,
		block: {
			type: "cache_edits";
			edits: Array<{ type: "delete"; cache_reference: string }>;
		},
	) => void;
};

function captureAnthropicPayload(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: CaptureAnthropicOptions,
): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamAnthropic(model, context, {
		apiKey: "sk-ant-oat-test",
		isOAuth: options?.isOAuth ?? true,
		signal: createAbortedSignal(),
		metadata: options?.metadata,
		thinkingEnabled: options?.thinkingEnabled,
		reasoning: options?.reasoning,
		temperature: options?.temperature,
		topP: options?.topP,
		topK: options?.topK,
		sessionId: options?.sessionId,
		cacheRetention: options?.cacheRetention,
		skipCacheWrite: options?.skipCacheWrite,
		querySource: "repl_main_thread",
		useCachedMicrocompact: options?.useCachedMicrocompact,
		newCacheEdits: options?.newCacheEdits,
		pinnedCacheEdits: options?.pinnedCacheEdits,
		onPinCacheEdits: options?.onPinCacheEdits,
		onPayload: payload => resolve(payload),
	});
	return promise;
}

describe("Anthropic request fingerprint alignment", () => {
	it("uses updated Claude Code header defaults", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
		});

		expect(headers["Anthropic-Beta"]).toContain("context-management-2025-06-27");
		expect(headers["Anthropic-Beta"]).toContain("prompt-caching-scope-2026-01-05");
		expect(headers["Anthropic-Beta"]).toContain("redact-thinking-2026-02-12");
		expect(headers["Anthropic-Beta"]).toContain("advisor-tool-2026-03-01");
		expect(headers["Anthropic-Beta"]).not.toContain("fine-grained-tool-streaming-2025-05-14");
		expect(headers["User-Agent"]).toBe(`claude-cli/${claudeCodeVersion} (external, cli)`);
		expect(headers.Accept).toBe("application/json");
		expect(headers["x-client-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
		expect(headers["X-Claude-Code-Session-Id"]).toMatch(/^[0-9a-f-]{36}$/);
		expect(claudeCodeHeaders["X-Stainless-Package-Version"]).toBe("0.81.0");

		const sessionHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			sessionId: "session-from-options",
		});
		expect(sessionHeaders["X-Claude-Code-Session-Id"]).toBe("session-from-options");
		expect("X-Stainless-Helper-Method" in claudeCodeHeaders).toBe(false);
	});

	it("maps Stainless OS and arch values from explicit inputs", () => {
		expect(mapStainlessOs("darwin")).toBe("MacOS");
		expect(mapStainlessOs("windows")).toBe("Windows");
		expect(mapStainlessOs("linux")).toBe("Linux");
		expect(mapStainlessOs("freebsd")).toBe("FreeBSD");
		expect(mapStainlessOs("solaris")).toBe("Other::solaris");

		expect(mapStainlessArch("x64")).toBe("x64");
		expect(mapStainlessArch("amd64")).toBe("x64");
		expect(mapStainlessArch("arm64")).toBe("arm64");
		expect(mapStainlessArch("386")).toBe("x86");
		expect(mapStainlessArch("x86")).toBe("x86");
		expect(mapStainlessArch("sparc64")).toBe("other::sparc64");
	});

	it("uses runtime Stainless OS and arch mappings in Anthropic headers", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
		});

		expect(headers["X-Stainless-Os"]).toBe(mapStainlessOs(process.platform));
		expect(headers["X-Stainless-Arch"]).toBe(mapStainlessArch(process.arch));
	});

	it("matches recovered Claude Code billing signature algorithms", () => {
		const bodyText =
			'{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"hi"}],"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.88.e09; cc_entrypoint=cli; cch=00000;"}]}';

		expect(computeClaudeVersionSuffix("hello from claude", "2.1.88")).toBe("808");
		expect(computeClaudeCch(bodyText)).toBe("2a528");
	});

	it("injects billing header and Claude Agent SDK identity block", () => {
		const blocks = buildAnthropicSystemBlocks(["Stay concise."], {
			includeClaudeCodeInstruction: true,
			extraInstructions: ["Use citations when possible"],
		});

		expect(blocks).toBeDefined();
		expect(blocks?.[0]?.text.startsWith(`x-anthropic-billing-header: cc_version=${claudeCodeVersion}.`)).toBe(true);
		expect(blocks?.[0]?.text).toMatch(/cc_entrypoint=cli; cch=00000;$/);
		expect(blocks?.[1]).toEqual({
			type: "text",
			text: claudeCodeSystemInstruction,
		});
		expect(blocks?.[2]).toEqual({
			type: "text",
			text: "Use citations when possible",
		});
		expect(blocks?.[3]).toEqual({
			type: "text",
			text: "Stay concise.",
		});
	});

	it("fills billing cch from the finalized serialized OAuth request body", async () => {
		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Stay concise."],
			messages: [{ role: "user", content: "Hi there from user", timestamp: Date.now() }],
		})) as { system?: Array<{ type: string; text?: string }> };
		const billingText = payload.system?.[0]?.text ?? "";
		const zeroedPayload = {
			...payload,
			system: payload.system?.map((block, index) =>
				index === 0 && block.text
					? { ...block, text: block.text.replace(/cch=[0-9a-f]{5};$/, "cch=00000;") }
					: block,
			),
		};

		expect(billingText).toMatch(/cc_version=2\.1\.126\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/);
		expect(billingText).not.toContain("cch=00000");
		expect(billingText).toContain(`cch=${computeClaudeCch(JSON.stringify(zeroedPayload))}`);
	});

	it("applies official-style system cache markers without caching billing blocks", () => {
		const blocks = buildAnthropicSystemBlocks(["Stay concise."], {
			includeClaudeCodeInstruction: true,
			extraInstructions: ["Use citations when possible"],
			cacheControl: { type: "ephemeral" },
		});

		expect(blocks).toBeDefined();
		expect(blocks?.[0]?.text?.startsWith(`x-anthropic-billing-header: cc_version=${claudeCodeVersion}.`)).toBe(true);
		expect(blocks?.[1]).toEqual({
			type: "text",
			text: claudeCodeSystemInstruction,
			cache_control: { type: "ephemeral" },
		});
		expect(blocks?.[2]).toEqual({
			type: "text",
			text: "Use citations when possible\n\nStay concise.",
			cache_control: { type: "ephemeral" },
		});
	});

	it("places official default system cache markers on the joined durable system prompt", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["stable system", "stable durable context"],
				messages: [{ role: "user", content: "variable context", timestamp: Date.now() }],
			},
			{ isOAuth: false },
		)) as { system?: Array<{ type: string; text?: string; cache_control?: unknown }> };

		expect(payload.system).toEqual([
			{
				type: "text",
				text: "stable system\n\nstable durable context",
				cache_control: { type: "ephemeral" },
			},
		]);
	});

	it("caches Claude Code identity and durable system prompt when no global boundary exists", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["stable system"],
				messages: [{ role: "user", content: "variable context", timestamp: Date.now() }],
			},
			{ isOAuth: true, thinkingEnabled: false },
		)) as { system?: Array<{ type: string; text?: string; cache_control?: unknown }> };

		expect(payload.system?.[0]?.text).toStartWith("x-anthropic-billing-header:");
		expect(payload.system?.[0]?.cache_control).toBeUndefined();
		expect(payload.system?.[1]).toEqual({
			type: "text",
			text: claudeCodeSystemInstruction,
			cache_control: { type: "ephemeral" },
		});
		expect(payload.system?.[2]).toEqual({
			type: "text",
			text: "stable system",
			cache_control: { type: "ephemeral" },
		});
	});

	it("uses global system cache only before the dynamic boundary", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["static identity", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "dynamic project context"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ isOAuth: false, cacheRetention: "long" },
		)) as { system?: Array<{ type: string; text?: string; cache_control?: unknown }> };

		expect(payload.system).toEqual([
			{
				type: "text",
				text: "static identity",
				cache_control: { type: "ephemeral", ttl: "1h", scope: "global" },
			},
			{ type: "text", text: "dynamic project context" },
		]);
	});

	it("keeps global system cache when an MCP tool is deferred from the Anthropic request", async () => {
		const deferredMcpTool = {
			name: "mcp__deferred_tool",
			description: "Deferred MCP tool",
			parameters: { type: "object", properties: {} } as unknown as TSchema,
			mcpServerName: "deferred-server",
			deferLoading: true,
		} as Tool & { mcpServerName: string; deferLoading: boolean };

		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["static identity", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "dynamic project context"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
				tools: [deferredMcpTool],
			},
			{ isOAuth: false },
		)) as { system?: Array<{ type: string; text?: string; cache_control?: unknown }> };

		expect(payload.system).toEqual([
			{
				type: "text",
				text: "static identity",
				cache_control: { type: "ephemeral", scope: "global" },
			},
			{ type: "text", text: "dynamic project context" },
		]);
	});

	it("does not add implicit tool cache-control when an MCP tool is rendered in the Anthropic request", async () => {
		const renderedMcpTool = {
			name: "mcp__rendered_tool",
			description: "Rendered MCP tool",
			parameters: { type: "object", properties: {} } as unknown as TSchema,
			mcpServerName: "rendered-server",
		} as Tool & { mcpServerName: string };

		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["static identity", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "dynamic project context"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
				tools: [renderedMcpTool],
			},
			{ isOAuth: false },
		)) as {
			system?: Array<{ type: string; text?: string; cache_control?: unknown }>;
			tools?: Array<{ name: string; cache_control?: unknown }>;
		};

		expect(payload.system).toEqual([
			{
				type: "text",
				text: "static identity\n\ndynamic project context",
				cache_control: { type: "ephemeral" },
			},
		]);
		expect(payload.tools?.[0]).toMatchObject({
			name: "mcp__rendered_tool",
			description: "Rendered MCP tool",
		});
		expect(payload.tools?.[0]?.cache_control).toBeUndefined();
	});

	it("emits deferred tool schemas and tool_reference result blocks for tool search", async () => {
		const deferredMcpTool = {
			name: "mcp__github_create_issue",
			description: "Create a GitHub issue",
			parameters: { type: "object", properties: {} } as unknown as TSchema,
			mcpServerName: "github",
			deferLoading: true,
		} as Tool & { mcpServerName: string; deferLoading: boolean };
		const searchTool = {
			name: "search_tool_bm25",
			description: "Search tools",
			parameters: { type: "object", properties: {} } as unknown as TSchema,
		} satisfies Tool;

		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["stable system"],
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "toolu_search",
								name: "search_tool_bm25",
								arguments: { query: "github issue" },
							},
						],
						api: "anthropic-messages",
						provider: "anthropic",
						model: ANTHROPIC_MODEL.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: Date.now(),
					},
					{
						role: "toolResult",
						toolCallId: "toolu_search",
						toolName: "search_tool_bm25",
						content: [{ type: "text", text: "", toolReferenceName: "mcp__github_create_issue" }],
						isError: false,
						timestamp: Date.now(),
					},
					{ role: "user", content: "Use that tool", timestamp: Date.now() },
				],
				tools: [searchTool, deferredMcpTool],
			},
			{ isOAuth: false },
		)) as {
			tools?: Array<{ name: string; defer_loading?: boolean }>;
			messages?: Array<{ role: string; content: Array<{ type: string; content?: unknown }> }>;
		};

		expect(payload.tools?.map(tool => tool.name)).toEqual(["search_tool_bm25", "mcp__github_create_issue"]);
		expect(payload.tools?.[1]).toMatchObject({ name: "mcp__github_create_issue", defer_loading: true });
		expect(payload.messages?.[2]?.content?.[0]).toMatchObject({
			type: "tool_result",
			content: [{ type: "tool_reference", tool_name: "mcp__github_create_issue" }],
		});
	});

	it("omits undiscovered deferred tool schemas until tool search returns a reference", async () => {
		const searchTool = {
			name: "search_tool_bm25",
			description: "Search tools",
			parameters: { type: "object", properties: {} } as unknown as TSchema,
		} satisfies Tool;
		const deferredMcpTool = {
			name: "mcp__github_create_issue",
			description: "Create a GitHub issue",
			parameters: { type: "object", properties: {} } as unknown as TSchema,
			mcpServerName: "github",
			deferLoading: true,
		} as Tool & { mcpServerName: string; deferLoading: boolean };

		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["stable system"],
				messages: [{ role: "user", content: "Find a GitHub tool", timestamp: Date.now() }],
				tools: [searchTool, deferredMcpTool],
			},
			{ isOAuth: false },
		)) as { tools?: Array<{ name: string; defer_loading?: boolean }> };

		expect(payload.tools?.map(tool => tool.name)).toEqual(["search_tool_bm25"]);
		expect(payload.tools?.some(tool => tool.defer_loading === true)).toBe(false);
	});

	it("uses compact-carried discovered tool references after tool-reference history is summarized", async () => {
		const searchTool = {
			name: "search_tool_bm25",
			description: "Search tools",
			parameters: { type: "object", properties: {} } as unknown as TSchema,
		} satisfies Tool;
		const deferredMcpTool = {
			name: "mcp__github_create_issue",
			description: "Create a GitHub issue",
			parameters: { type: "object", properties: {} } as unknown as TSchema,
			mcpServerName: "github",
			deferLoading: true,
		} as Tool & { mcpServerName: string; deferLoading: boolean };

		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["stable system"],
				messages: [
					{
						role: "user",
						content: "Previous context summarized.",
						providerPayload: {
							type: "anthropicDiscoveredTools",
							toolNames: ["mcp__github_create_issue"],
						},
						timestamp: Date.now(),
					},
					{ role: "user", content: "Use the discovered tool", timestamp: Date.now() },
				],
				tools: [searchTool, deferredMcpTool],
			},
			{ isOAuth: false },
		)) as { tools?: Array<{ name: string; defer_loading?: boolean }> };

		expect(payload.tools?.map(tool => tool.name)).toEqual(["search_tool_bm25", "mcp__github_create_issue"]);
		expect(payload.tools?.[1]).toMatchObject({ name: "mcp__github_create_issue", defer_loading: true });
	});

	it("disables auto tool search below the official character threshold", async () => {
		await withEnv({ ENABLE_TOOL_SEARCH: "auto:100" }, async () => {
			const searchTool = {
				name: "search_tool_bm25",
				description: "Search tools",
				parameters: { type: "object", properties: {} } as unknown as TSchema,
			} satisfies Tool;
			const deferredMcpTool = {
				name: "mcp__github_create_issue",
				description: "Create a GitHub issue",
				parameters: { type: "object", properties: {} } as unknown as TSchema,
				mcpServerName: "github",
				deferLoading: true,
			} as Tool & { mcpServerName: string; deferLoading: boolean };

			const payload = (await captureAnthropicPayload(
				ANTHROPIC_MODEL,
				{
					systemPrompt: ["stable system"],
					messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
					tools: [searchTool, deferredMcpTool],
				},
				{ isOAuth: false },
			)) as { tools?: Array<{ name: string; defer_loading?: boolean }> };

			expect(payload.tools?.map(tool => tool.name)).toEqual(["search_tool_bm25", "mcp__github_create_issue"]);
			expect(payload.tools?.some(tool => tool.defer_loading === true)).toBe(false);
		});
	});

	it("applies explicit tool cache-control without mutating deferred tool-search schemas", async () => {
		const explicitTool = {
			name: "read",
			description: "Read files",
			parameters: { type: "object", properties: {} } as unknown as TSchema,
			cacheControl: { type: "ephemeral" as const, ttl: "5m" as const },
		} satisfies Tool;
		const deferredMcpTool = {
			name: "mcp__github_create_issue",
			description: "Create a GitHub issue",
			parameters: { type: "object", properties: {} } as unknown as TSchema,
			mcpServerName: "github",
			deferLoading: true,
		} as Tool & { mcpServerName: string; deferLoading: boolean };
		const searchTool = {
			name: "search_tool_bm25",
			description: "Search tools",
			parameters: { type: "object", properties: {} } as unknown as TSchema,
		} satisfies Tool;

		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["stable system"],
				messages: [
					{
						role: "toolResult",
						toolCallId: "toolu_search",
						toolName: "search_tool_bm25",
						content: [{ type: "text", text: "", toolReferenceName: "mcp__github_create_issue" }],
						isError: false,
						timestamp: Date.now(),
					},
					{ role: "user", content: "hello", timestamp: Date.now() },
				],
				tools: [explicitTool, searchTool, deferredMcpTool],
			},
			{ isOAuth: false },
		)) as { tools?: Array<{ name: string; cache_control?: unknown; defer_loading?: boolean }> };

		expect(payload.tools?.[0]).toMatchObject({
			name: "read",
			cache_control: { type: "ephemeral", ttl: "5m" },
		});
		expect(payload.tools?.[2]).toMatchObject({
			name: "mcp__github_create_issue",
			defer_loading: true,
		});
		expect(payload.tools?.[2]?.cache_control).toBeUndefined();
	});

	it("strips tool_reference blocks when tool search is unavailable", async () => {
		const deferredMcpTool = {
			name: "mcp__github_create_issue",
			description: "Create a GitHub issue",
			parameters: { type: "object", properties: {} } as unknown as TSchema,
			mcpServerName: "github",
			deferLoading: true,
		} as Tool & { mcpServerName: string; deferLoading: boolean };

		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["stable system"],
				messages: [
					{
						role: "toolResult",
						toolCallId: "toolu_search",
						toolName: "search_tool_bm25",
						content: [{ type: "text", text: "", toolReferenceName: "mcp__github_create_issue" }],
						isError: false,
						timestamp: Date.now(),
					},
					{ role: "user", content: "hello", timestamp: Date.now() },
				],
				tools: [deferredMcpTool],
			},
			{ isOAuth: false },
		)) as { messages?: Array<{ role: string; content: Array<{ type: string; content?: unknown }> }> };

		expect(payload.messages?.[0]?.content?.[0]).toMatchObject({
			type: "tool_result",
			content: [{ type: "text", text: "[Tool references removed - tool search not enabled]" }],
		});
	});

	it("orders Anthropic OAuth body fields like the official beta messages client", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ isOAuth: true, thinkingEnabled: false },
		)) as Record<string, unknown>;

		expect(Object.keys(payload)).toEqual([
			"model",
			"messages",
			"system",
			"metadata",
			"max_tokens",
			"thinking",
			"stream",
		]);
	});

	it("emits context management for cacheable thinking requests", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "solve carefully", timestamp: Date.now() }],
			},
			{ isOAuth: true, thinkingEnabled: true },
		)) as Record<string, unknown>;

		expect(Object.keys(payload)).toEqual([
			"model",
			"messages",
			"system",
			"metadata",
			"max_tokens",
			"thinking",
			"context_management",
			"stream",
		]);
		expect(payload.context_management).toEqual({
			edits: [{ type: "clear_thinking_20251015", keep: "all" }],
		});
	});

	it("sends OAuth streams through the beta messages endpoint", async () => {
		const originalFetch = global.fetch;
		let requestUrl = "";
		try {
			global.fetch = (async (input: string | URL | Request) => {
				requestUrl = input instanceof Request ? input.url : String(input);
				return new Response(
					[
						'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-5","id":"msg_mock","type":"message","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
						'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
						'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
						'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
						'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
						'event: message_stop\ndata: {"type":"message_stop"}',
					].join("\n\n"),
					{ headers: { "content-type": "text/event-stream", "request-id": "req_mock" } },
				);
			}) as typeof fetch;

			const stream = streamAnthropic(
				ANTHROPIC_MODEL,
				{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
				{ apiKey: "sk-ant-oat-test", isOAuth: true, thinkingEnabled: false, streamFirstEventTimeoutMs: 0 },
			);
			for await (const _event of stream) {
				// drain
			}
			await stream.result();

			expect(requestUrl).toBe("https://api.anthropic.com/v1/messages?beta=true");
		} finally {
			global.fetch = originalFetch;
		}
	});

	it("uses a single last-message cache marker without cache_reference in ordinary prompt caching", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [
					{ role: "user", content: "Open the file", timestamp: Date.now() },
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: ANTHROPIC_MODEL.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: Date.now(),
					},
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "read",
						content: [{ type: "text", text: "file contents" }],
						isError: false,
						timestamp: Date.now(),
					},
					{
						role: "assistant",
						content: [{ type: "text", text: "Done." }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: ANTHROPIC_MODEL.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
				],
			},
			{ isOAuth: true },
		)) as {
			messages?: Array<{
				role: string;
				content: Array<{
					type: string;
					cache_control?: unknown;
					cache_reference?: string;
					tool_use_id?: string;
				}>;
			}>;
		};

		expect(payload.messages?.at(-1)?.content.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
		const toolResultBlock = payload.messages?.[2]?.content?.[0];
		expect(toolResultBlock?.tool_use_id).toBe("call_1");
		expect(toolResultBlock?.cache_reference).toBeUndefined();
		expect(
			payload.messages
				?.slice(0, -1)
				.flatMap(message => message.content)
				.filter(block => block.cache_control != null),
		).toHaveLength(0);
	});

	it("matches Claude Code cached microcompact cache_edits and cache_reference placement", async () => {
		const pinnedBlock = {
			type: "cache_edits" as const,
			edits: [{ type: "delete" as const, cache_reference: "old_tool" }],
		};
		const newBlock = {
			type: "cache_edits" as const,
			edits: [
				{ type: "delete" as const, cache_reference: "old_tool" },
				{ type: "delete" as const, cache_reference: "call_1" },
			],
		};
		const pinned: Array<{ userMessageIndex: number; block: typeof newBlock }> = [];
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				messages: [
					{ role: "user", content: "Open the file", timestamp: Date.now() },
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: ANTHROPIC_MODEL.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: Date.now(),
					},
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "read",
						content: [{ type: "text", text: "file contents" }],
						isError: false,
						timestamp: Date.now(),
					},
					{ role: "user", content: "Summarize the file", timestamp: Date.now() },
				],
			},
			{
				isOAuth: true,
				useCachedMicrocompact: true,
				pinnedCacheEdits: [{ userMessageIndex: 2, block: pinnedBlock }],
				newCacheEdits: newBlock,
				onPinCacheEdits: (userMessageIndex, block) => pinned.push({ userMessageIndex, block }),
			},
		)) as {
			messages?: Array<{
				role: string;
				content: Array<{
					type: string;
					cache_control?: unknown;
					cache_reference?: string;
					tool_use_id?: string;
					edits?: Array<{ type: string; cache_reference: string }>;
					text?: string;
				}>;
			}>;
		};

		expect(payload.messages?.at(-1)?.content.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
		const userToolResultContent = payload.messages?.[2]?.content;
		expect(userToolResultContent?.[0]).toMatchObject({
			type: "tool_result",
			tool_use_id: "call_1",
			cache_reference: "call_1",
		});
		expect(userToolResultContent?.[1]).toEqual(pinnedBlock);
		expect(userToolResultContent?.[2]).toEqual({ type: "text", text: "." });
		expect(payload.messages?.[3]?.content?.[0]).toEqual({
			type: "cache_edits",
			edits: [{ type: "delete", cache_reference: "call_1" }],
		});
		expect(payload.messages?.[3]?.content?.[1]).toMatchObject({
			type: "text",
			text: "Summarize the file",
			cache_control: { type: "ephemeral" },
		});
		expect(pinned).toEqual([{ userMessageIndex: 3, block: newBlock }]);
	});

	it("uses the second-to-last message marker when cache writes are skipped", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				messages: [
					{ role: "user", content: "Original request", timestamp: Date.now() },
					{
						role: "assistant",
						content: [{ type: "text", text: "Shared answer prefix." }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: ANTHROPIC_MODEL.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
					{ role: "user", content: "Ephemeral side question", timestamp: Date.now() },
				],
			},
			{ isOAuth: false, skipCacheWrite: true },
		)) as {
			messages?: Array<{
				content: Array<{ cache_control?: unknown }>;
			}>;
		};

		expect(payload.messages?.[1]?.content.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
		expect(payload.messages?.[2]?.content.at(-1)?.cache_control).toBeUndefined();
	});

	it("does not move a skipped cache-write marker off assistant thinking tails", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				messages: [
					{ role: "user", content: "Original request", timestamp: Date.now() },
					{
						role: "assistant",
						content: [
							{ type: "text", text: "Shared answer prefix." },
							{ type: "redactedThinking", data: "encrypted-thinking" },
						],
						api: "anthropic-messages",
						provider: "anthropic",
						model: ANTHROPIC_MODEL.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
					{ role: "user", content: "Ephemeral side question", timestamp: Date.now() },
				],
			},
			{ isOAuth: false, skipCacheWrite: true },
		)) as {
			messages?: Array<{
				content: string | Array<{ cache_control?: unknown }>;
			}>;
		};

		const messageCacheControls =
			payload.messages?.flatMap(message =>
				Array.isArray(message.content) ? message.content.filter(block => block.cache_control != null) : [],
			) ?? [];
		expect(messageCacheControls).toHaveLength(0);
	});

	it("uses Bearer auth for non-Anthropic API bases with api-key credentials", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-api-test",
			baseUrl: "https://proxy.example.com",
			stream: true,
		});

		expect(headers.Authorization).toBe("Bearer sk-ant-api-test");
		expect(headers["X-Api-Key"]).toBeUndefined();
	});

	it("forwards only prefix-matching Claude Code User-Agent values", () => {
		const forwardedHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { "User-Agent": "claude-cli/2.1.63 (external, cli)" },
		});
		expect(forwardedHeaders["User-Agent"]).toBe("claude-cli/2.1.63 (external, cli)");

		// Test variant without slash
		const forwardedNoSlashHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { "User-Agent": "claude-cli-dev" },
		});
		expect(forwardedNoSlashHeaders["User-Agent"]).toBe("claude-cli-dev");

		const normalizedHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { "User-Agent": "curl/8.7.1" },
		});
		expect(normalizedHeaders["User-Agent"]).toBe(`claude-cli/${claudeCodeVersion} (external, cli)`);

		const embeddedClaudeCliHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { "User-Agent": "my-client claude-cli/2.1.63" },
		});
		expect(embeddedClaudeCliHeaders["User-Agent"]).toBe(`claude-cli/${claudeCodeVersion} (external, cli)`);
	});

	it("skips Claude Code instruction injection for claude-3-5-haiku models", async () => {
		const payload = (await captureAnthropicPayload(
			{ ...ANTHROPIC_MODEL, id: "claude-3-5-haiku", name: "Claude 3.5 Haiku" },
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
		)) as { system?: Array<{ type: string; text?: string }> };

		expect(Array.isArray(payload.system)).toBe(true);
		const systemBlocks = payload.system ?? [];
		expect(systemBlocks.some(block => block.text?.startsWith("x-anthropic-billing-header:"))).toBe(false);
		expect(systemBlocks[0]?.text).toBe("Stay concise.");
	});

	it("validates Claude Code JSON metadata user IDs", () => {
		const userId = JSON.stringify({
			device_id: "device",
			account_uuid: "account",
			session_id: "session",
		});
		expect(isClaudeCloakingUserId(userId)).toBe(true);
	});

	it("generates cloaking-compatible user IDs", () => {
		const userId = generateClaudeCloakingUserId();
		expect(isClaudeCloakingUserId(userId)).toBe(true);
	});

	it("injects generated metadata.user_id for OAuth requests when missing", async () => {
		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Stay concise."],
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		})) as { metadata?: { user_id?: string } };
		const userId = payload.metadata?.user_id;
		expect(typeof userId).toBe("string");
		expect(isClaudeCloakingUserId(userId ?? "")).toBe(true);
	});

	it("derives OAuth metadata IDs from OMP-managed Anthropic metadata and session", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-claude-config-"));
		const deviceId = "a".repeat(64);
		const accountUuid = "12345678-1234-1234-1234-1234567890ab";
		try {
			fs.writeFileSync(
				path.join(dir, "anthropic-oauth.json"),
				JSON.stringify({
					userID: deviceId,
					oauthAccount: { accountUuid },
				}),
			);
			await withEnv(
				{
					OMP_ANTHROPIC_METADATA_PATH: path.join(dir, "anthropic-oauth.json"),
					CLAUDE_CODE_EXTRA_METADATA: JSON.stringify({ workload: "test", session_id: "ignored" }),
				},
				async () => {
					const payload = (await captureAnthropicPayload(
						ANTHROPIC_MODEL,
						{
							systemPrompt: ["Stay concise."],
							messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
						},
						{ sessionId: "session-from-options" },
					)) as { metadata?: { user_id?: string } };
					const metadata = JSON.parse(payload.metadata?.user_id ?? "{}") as {
						device_id?: string;
						account_uuid?: string;
						session_id?: string;
						workload?: string;
					};

					expect(metadata.device_id).toBe(deviceId);
					expect(metadata.account_uuid).toBe(accountUuid);
					expect(metadata.session_id).toBe("session-from-options");
					expect(metadata.workload).toBe("test");
				},
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not inject metadata.user_id for non-OAuth requests without caller metadata", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ isOAuth: false },
		)) as { metadata?: { user_id?: string } };
		expect(payload.metadata).toBeUndefined();
	});

	it("preserves parseable caller metadata.user_id fields for OAuth requests", async () => {
		const userId = JSON.stringify({ existing: "keep" });
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ metadata: { user_id: userId } },
		)) as { metadata?: { user_id?: string } };
		const parsed = JSON.parse(payload.metadata?.user_id ?? "{}") as { existing?: string };

		expect(parsed.existing).toBe("keep");
		expect(isClaudeCloakingUserId(payload.metadata?.user_id ?? "")).toBe(true);
	});

	it("replaces invalid caller metadata.user_id for OAuth requests", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ metadata: { user_id: "invalid-user-id" } },
		)) as { metadata?: { user_id?: string } };

		expect(payload.metadata?.user_id).not.toBe("invalid-user-id");
		expect(isClaudeCloakingUserId(payload.metadata?.user_id ?? "")).toBe(true);
	});
	it("adds additionalProperties false to Anthropic tool object schemas", async () => {
		const originalNestedSchema = {
			type: "object",
			properties: {
				path: { type: "string" },
			},
			patternProperties: {
				"^x-": { type: "string" },
			},
			required: ["path"],
		};
		const tools: Tool[] = [
			{
				name: "edit_file",
				description: "edit files",
				parameters: {
					type: "object",
					properties: {
						target: originalNestedSchema,
						operations: {
							type: "array",
							items: {
								type: "object",
								properties: { content: { type: "string" } },
								required: ["content"],
							},
						},
						env: {
							type: "object",
							patternProperties: {
								"^[A-Za-z_][A-Za-z0-9_]*$": { type: "string" },
							},
						},
					},
					required: ["target"],
				} as unknown as TSchema,
			},
		];

		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Stay concise."],
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			tools,
		})) as {
			tools?: Array<{
				input_schema?: {
					additionalProperties?: boolean;
					properties?: Record<string, unknown>;
					required?: string[];
				};
			}>;
		};

		const inputSchema = payload.tools?.[0]?.input_schema;
		const properties = inputSchema?.properties as Record<string, Record<string, unknown>>;
		const target = properties.target as { additionalProperties?: boolean; patternProperties?: unknown };
		const operations = properties.operations as {
			type?: string;
			items?: { additionalProperties?: boolean; required?: string[] };
		};
		const env = properties.env as { additionalProperties?: boolean; patternProperties?: unknown };

		expect(inputSchema?.additionalProperties).toBe(false);
		expect(inputSchema?.required).toEqual(["target"]);
		expect(target.additionalProperties).toBe(false);
		expect(operations.type).toBe("array");
		expect(operations.items?.additionalProperties).toBe(false);
		expect(operations.items?.required).toEqual(["content"]);
		expect(target).not.toHaveProperty("patternProperties");
		expect(env.additionalProperties).toBe(false);
		expect(env).not.toHaveProperty("patternProperties");
		expect(inputSchema?.properties).toHaveProperty("target");
		expect(originalNestedSchema).not.toHaveProperty("additionalProperties");
		expect(originalNestedSchema).toHaveProperty("patternProperties");
	});

	it("removes Anthropic-unsupported array item count constraints", async () => {
		const tools: Tool[] = [
			{
				name: "edit_file",
				description: "edit files",
				parameters: {
					type: "object",
					properties: {
						sub: {
							type: "array",
							items: { type: "string" },
							minItems: 2,
							maxItems: 2,
						},
						nonEmpty: {
							type: "array",
							items: { type: "string" },
							minItems: 1,
						},
					},
					required: ["sub"],
				} as unknown as TSchema,
			},
		];

		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Stay concise."],
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			tools,
		})) as {
			tools?: Array<{
				input_schema?: {
					properties?: Record<string, unknown>;
				};
			}>;
		};

		const properties = payload.tools?.[0]?.input_schema?.properties as Record<string, Record<string, unknown>>;

		expect(properties.sub).not.toHaveProperty("minItems");
		expect(properties.sub).not.toHaveProperty("maxItems");
		expect(properties.nonEmpty.minItems).toBe(1);
	});

	it("strips minItems from object-typed property schemas (Anthropic rejects them)", async () => {
		const tools: Tool[] = [
			{
				name: "weird",
				description: "nested object with stray minItems",
				parameters: {
					type: "object",
					properties: {
						block: {
							type: "object",
							properties: { a: { type: "string" } },
							required: ["a"],
							minItems: 1,
						},
					},
					required: ["block"],
				} as unknown as TSchema,
			},
		];

		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: ["Stay concise."],
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			tools,
		})) as {
			tools?: Array<{
				input_schema?: { properties?: Record<string, unknown> };
			}>;
		};

		const block = payload.tools?.[0]?.input_schema?.properties?.block as Record<string, unknown> | undefined;
		expect(block?.type).toBe("object");
		expect(block).not.toHaveProperty("minItems");
	});

	it("marks only the Anthropic strict allowlist strict", async () => {
		const tools: Tool[] = [
			...(["bash", "python", "edit", "find"] as const).map(name => ({
				name,
				description: `${name} tool`,
				strict: true,
				parameters: {
					type: "object",
					properties: { requiredValue: { type: "string" } },
					required: ["requiredValue"],
				} as unknown as TSchema,
			})),
			...(["write", "grep", "read", "task", "todo_write", "web_search", "ast_grep"] as const).map(name => ({
				name,
				description: `${name} tool`,
				strict: true,
				parameters: {
					type: "object",
					properties: { requiredValue: { type: "string" } },
					required: ["requiredValue"],
				} as unknown as TSchema,
			})),
		];

		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				tools,
			},
			{ isOAuth: false },
		)) as {
			tools?: Array<{ name?: string; strict?: boolean; input_schema?: { required?: string[] } }>;
		};

		const strictNames = (payload.tools ?? []).filter(tool => tool.strict === true).map(tool => tool.name);

		expect(strictNames).toEqual(["bash", "python", "edit", "find"]);
		expect(payload.tools?.find(tool => tool.name === "bash")?.input_schema?.required).toEqual(["requiredValue"]);
	});

	it("honors strict=false and skips non-allowlisted Anthropic tools", async () => {
		const tools: Tool[] = [
			{
				name: "bash",
				description: "bash tool",
				strict: false,
				parameters: {
					type: "object",
					properties: { requiredValue: { type: "string" } },
					required: ["requiredValue"],
				} as unknown as TSchema,
			},
			{
				name: "python",
				description: "python tool",
				strict: true,
				parameters: {
					type: "object",
					properties: { requiredValue: { type: "string" } },
					required: ["requiredValue"],
				} as unknown as TSchema,
			},
			{
				name: "write",
				description: "write tool",
				parameters: {
					type: "object",
					properties: { requiredValue: { type: "string" } },
					required: ["requiredValue"],
				} as unknown as TSchema,
			},
			{
				name: "grep",
				description: "grep tool",
				strict: true,
				parameters: {
					type: "object",
					properties: { requiredValue: { type: "string" } },
					required: ["requiredValue"],
				} as unknown as TSchema,
			},
		];

		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				tools,
			},
			{ isOAuth: false },
		)) as { tools?: Array<{ name?: string; strict?: boolean }> };

		const strictNames = (payload.tools ?? []).filter(tool => tool.strict === true).map(tool => tool.name);
		expect(strictNames).toEqual(["python"]);
	});

	it("drops fine-grained tool-streaming beta from default Anthropic client options", () => {
		const options = buildAnthropicClientOptions({
			model: ANTHROPIC_MODEL,
			apiKey: "sk-ant-oat-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			dynamicHeaders: {},
		});

		const beta = options.defaultHeaders["Anthropic-Beta"];
		expect(beta).toContain("context-management-2025-06-27");
		expect(beta).not.toContain("fine-grained-tool-streaming-2025-05-14");
	});

	it("adds legacy fine-grained tool-streaming beta only for tool requests on incompatible models", () => {
		const incompatibleModel: Model<"anthropic-messages"> = {
			...ANTHROPIC_MODEL,
			compat: { supportsEagerToolInputStreaming: false },
		};

		const withoutTools = buildAnthropicClientOptions({
			model: incompatibleModel,
			apiKey: "sk-ant-api-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			hasTools: false,
		});
		const withCompatibleTools = buildAnthropicClientOptions({
			model: ANTHROPIC_MODEL,
			apiKey: "sk-ant-api-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			hasTools: true,
		});
		const withIncompatibleTools = buildAnthropicClientOptions({
			model: incompatibleModel,
			apiKey: "sk-ant-api-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			hasTools: true,
		});

		expect(withoutTools.defaultHeaders["Anthropic-Beta"]).not.toContain("fine-grained-tool-streaming-2025-05-14");
		expect(withCompatibleTools.defaultHeaders["Anthropic-Beta"]).not.toContain(
			"fine-grained-tool-streaming-2025-05-14",
		);
		expect(withIncompatibleTools.defaultHeaders["Anthropic-Beta"]).toContain(
			"fine-grained-tool-streaming-2025-05-14",
		);
	});

	it("uses Cloudflare AI Gateway authorization without Anthropic credential headers", () => {
		const options = buildAnthropicClientOptions({
			model: CLOUDFLARE_ANTHROPIC_MODEL,
			apiKey: "cf-gateway-token",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			dynamicHeaders: {},
		});

		expect(options.baseURL).toBe("https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic");
		expect(options.apiKey).toBeNull();
		expect(options.authToken).toBeNull();
		expect(options.defaultHeaders["cf-aig-authorization"]).toBe("Bearer cf-gateway-token");
		expect(options.defaultHeaders.Authorization).toBeUndefined();
		expect(options.defaultHeaders["X-Api-Key"]).toBeUndefined();
	});

	it("keeps Cloudflare gateway auth authoritative over caller-supplied auth headers", () => {
		const options = buildAnthropicClientOptions({
			model: {
				...CLOUDFLARE_ANTHROPIC_MODEL,
				headers: {
					Authorization: "Bearer anthropic-oauth",
					"X-Api-Key": "sk-ant-api-leak",
					"cf-aig-authorization": "Bearer stale-token",
				},
			},
			apiKey: "cf-gateway-token",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			dynamicHeaders: {},
		});

		expect(options.defaultHeaders["cf-aig-authorization"]).toBe("Bearer cf-gateway-token");
		expect(options.defaultHeaders.Authorization).toBeUndefined();
		expect(options.defaultHeaders["X-Api-Key"]).toBeUndefined();
	});

	it("applies Claude Code TLS profile for direct Anthropic transport", () => {
		const options = buildAnthropicClientOptions({
			model: ANTHROPIC_MODEL,
			apiKey: "sk-ant-oat-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			dynamicHeaders: {},
		});

		const tlsOptions = (
			options.fetchOptions as
				| {
						tls?: {
							rejectUnauthorized?: boolean;
							serverName?: string;
							ciphers?: string;
						};
				  }
				| undefined
		)?.tls;
		expect(tlsOptions).toBeDefined();
		expect(tlsOptions?.rejectUnauthorized).toBe(true);
		expect(tlsOptions?.serverName).toBe("api.anthropic.com");
		expect(tlsOptions?.ciphers).toBe(tls.DEFAULT_CIPHERS);
	});

	it("uses Foundry base URL, Bearer auth, and custom headers when enabled", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: "https://foundry.example.com/anthropic/",
				ANTHROPIC_CUSTOM_HEADERS: "user-id: alice, x-route: engineering",
			},
			() => {
				const options = buildAnthropicClientOptions({
					model: ANTHROPIC_MODEL,
					apiKey: "foundry-token",
					extraBetas: [],
					stream: true,
					interleavedThinking: false,
					dynamicHeaders: {},
				});

				expect(options.baseURL).toBe("https://foundry.example.com/anthropic");
				expect(options.defaultHeaders.Authorization).toBe("Bearer foundry-token");
				expect(options.defaultHeaders["X-Api-Key"]).toBeUndefined();
				expect(options.defaultHeaders["user-id"]).toBe("alice");
				expect(options.defaultHeaders["x-route"]).toBe("engineering");
			},
		);
	});

	it("loads Foundry mTLS and CA material from file paths", async () => {
		const tmpDir = path.join(os.tmpdir(), `pi-ai-foundry-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		fs.mkdirSync(tmpDir, { recursive: true });
		const caPath = path.join(tmpDir, "ca.pem");
		const certPath = path.join(tmpDir, "client-cert.pem");
		const keyPath = path.join(tmpDir, "client-key.pem");
		fs.writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n", "utf8");
		fs.writeFileSync(certPath, "-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----\n", "utf8");
		fs.writeFileSync(keyPath, "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n", "utf8");

		try {
			await withEnv(
				{
					CLAUDE_CODE_USE_FOUNDRY: "1",
					FOUNDRY_BASE_URL: "https://foundry.example.com",
					NODE_EXTRA_CA_CERTS: caPath,
					CLAUDE_CODE_CLIENT_CERT: certPath,
					CLAUDE_CODE_CLIENT_KEY: keyPath,
				},
				() => {
					const options = buildAnthropicClientOptions({
						model: ANTHROPIC_MODEL,
						apiKey: "foundry-token",
						extraBetas: [],
						stream: true,
						interleavedThinking: false,
						dynamicHeaders: {},
					});

					const tlsOptions = (
						options.fetchOptions as
							| {
									tls?: {
										serverName?: string;
										ca?: string | string[];
										cert?: string;
										key?: string;
									};
							  }
							| undefined
					)?.tls;
					expect(tlsOptions?.serverName).toBe("foundry.example.com");
					expect(Array.isArray(tlsOptions?.ca)).toBe(true);
					const caValues = (tlsOptions?.ca ?? []) as string[];
					expect(caValues.length).toBeGreaterThanOrEqual(tls.rootCertificates.length + 1);
					expect(caValues.slice(0, tls.rootCertificates.length)).toEqual([...tls.rootCertificates]);
					expect(caValues.at(-1)).toContain("BEGIN CERTIFICATE");
					expect(tlsOptions?.cert).toContain("BEGIN CERTIFICATE");
					expect(tlsOptions?.key).toContain("BEGIN PRIVATE KEY");
				},
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("throws when Foundry mTLS cert/key pair is incomplete", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: "https://foundry.example.com",
				CLAUDE_CODE_CLIENT_CERT: "-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----\n",
				CLAUDE_CODE_CLIENT_KEY: undefined,
			},
			() => {
				expect(() =>
					buildAnthropicClientOptions({
						model: ANTHROPIC_MODEL,
						apiKey: "foundry-token",
						extraBetas: [],
						stream: true,
						interleavedThinking: false,
						dynamicHeaders: {},
					}),
				).toThrow("Both CLAUDE_CODE_CLIENT_CERT and CLAUDE_CODE_CLIENT_KEY must be set for mTLS.");
			},
		);
	});

	it("resolves Anthropic Foundry API key when Foundry mode is enabled", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				ANTHROPIC_FOUNDRY_API_KEY: "foundry-env-token",
				ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-should-not-win",
				ANTHROPIC_API_KEY: "sk-ant-api-should-not-win",
			},
			() => {
				expect(getEnvApiKey("anthropic")).toBe("foundry-env-token");
			},
		);
	});

	it("sends temperature for Anthropic requests without enabled thinking", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ temperature: 0.2 },
		)) as { temperature?: number; thinking?: { type?: string } };

		expect(payload.temperature).toBe(0.2);
		expect(payload.thinking).toBeUndefined();
	});

	it("sends disabled thinking for reasoning models when thinking is explicitly disabled", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ thinkingEnabled: false },
		)) as { thinking?: { type?: string } };

		expect(payload.thinking).toEqual({ type: "disabled" });
	});

	it("drops temperature and sampling params for Opus 4.7 without enabled thinking", async () => {
		const payload = (await captureAnthropicPayload(
			{ ...ANTHROPIC_MODEL, id: "claude-opus-4-7", name: "Claude Opus 4.7" },
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				temperature: 0.2,
				topP: 0.3,
				topK: 4,
			},
		)) as {
			temperature?: number;
			top_p?: number;
			top_k?: number;
			thinking?: { type?: string };
		};

		expect(payload.temperature).toBeUndefined();
		expect(payload.top_p).toBeUndefined();
		expect(payload.top_k).toBeUndefined();
		expect(payload.thinking).toBeUndefined();
	});

	it("drops sampling params and requests summarized adaptive thinking for Opus 4.7", async () => {
		const payload = (await captureAnthropicPayload(
			{
				...ANTHROPIC_MODEL,
				id: "claude-opus-4-7",
				name: "Claude Opus 4.7",
				thinking: {
					mode: "anthropic-adaptive",
					minLevel: Effort.Minimal,
					maxLevel: Effort.XHigh,
				},
			},
			{
				systemPrompt: ["Stay concise."],
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				thinkingEnabled: true,
				reasoning: Effort.High,
				temperature: 0.2,
				topP: 0.3,
				topK: 4,
			},
		)) as {
			temperature?: number;
			top_p?: number;
			top_k?: number;
			thinking?: { type?: string; display?: string };
			output_config?: { effort?: string };
		};

		expect(payload.temperature).toBeUndefined();
		expect(payload.top_p).toBeUndefined();
		expect(payload.top_k).toBeUndefined();
		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "high" });
	});

	it("treats tool prefix helpers as no-ops when prefix is empty", () => {
		expect(applyClaudeToolPrefix("Read", "")).toBe("Read");
		expect(stripClaudeToolPrefix("mcp_Read", "")).toBe("mcp_Read");
	});

	it("does not prefix built-in Anthropic tool names when prefix is configured", () => {
		expect(applyClaudeToolPrefix("web_search", "mcp_")).toBe("web_search");
		expect(applyClaudeToolPrefix("CODE_EXECUTION", "mcp_")).toBe("CODE_EXECUTION");
		expect(applyClaudeToolPrefix("Text_Editor", "mcp_")).toBe("Text_Editor");
		expect(applyClaudeToolPrefix("computer", "mcp_")).toBe("computer");
	});

	it("prefixes custom tool names when prefix is configured", () => {
		expect(applyClaudeToolPrefix("read", "mcp_")).toBe("mcp_Read");
		expect(applyClaudeToolPrefix("mcp_Read", "mcp_")).toBe("mcp_Read");
		expect(stripClaudeToolPrefix("mcp_Read", "mcp_")).toBe("read");
	});
});
