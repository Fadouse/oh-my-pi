import * as nodeCrypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { $env, getConfigRootDir, isRecord } from "@oh-my-pi/pi-utils";

export type AnthropicOAuthAccountInfo = {
	accountUuid: string;
	emailAddress?: string;
	organizationUuid?: string;
};

type AnthropicMetadataConfig = {
	userID?: unknown;
	oauthAccount?: {
		accountUuid?: unknown;
		emailAddress?: unknown;
		organizationUuid?: unknown;
	};
};

export type AnthropicMetadataUserId = {
	device_id: string;
	account_uuid: string;
	session_id: string;
} & Record<string, unknown>;

function getAnthropicMetadataConfigPath(): string {
	return $env.OMP_ANTHROPIC_METADATA_PATH || path.join(getConfigRootDir(), "anthropic-oauth.json");
}

function readAnthropicMetadataConfig(): AnthropicMetadataConfig {
	try {
		return JSON.parse(fs.readFileSync(getAnthropicMetadataConfigPath(), "utf8")) as AnthropicMetadataConfig;
	} catch {
		return {};
	}
}

function writeAnthropicMetadataConfig(config: AnthropicMetadataConfig): void {
	const configPath = getAnthropicMetadataConfigPath();
	fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
	fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
	try {
		fs.chmodSync(configPath, 0o600);
	} catch {
		// Best effort on platforms/filesystems that do not support chmod.
	}
}

export function getOrCreateAnthropicDeviceId(): string {
	const config = readAnthropicMetadataConfig();
	if (typeof config.userID === "string") return config.userID;
	const userID = nodeCrypto.randomBytes(32).toString("hex");
	writeAnthropicMetadataConfig({ ...config, userID });
	return userID;
}

export function storeAnthropicOAuthMetadata(accountInfo?: AnthropicOAuthAccountInfo): void {
	const config = readAnthropicMetadataConfig();
	const userID = typeof config.userID === "string" ? config.userID : nodeCrypto.randomBytes(32).toString("hex");
	const oauthAccount = accountInfo
		? {
				accountUuid: accountInfo.accountUuid,
				...(accountInfo.emailAddress ? { emailAddress: accountInfo.emailAddress } : {}),
				...(accountInfo.organizationUuid ? { organizationUuid: accountInfo.organizationUuid } : {}),
			}
		: config.oauthAccount;
	writeAnthropicMetadataConfig({ ...config, userID, ...(oauthAccount ? { oauthAccount } : {}) });
}

function getAnthropicAccountUuid(config: AnthropicMetadataConfig): string {
	const accountUuid = config.oauthAccount?.accountUuid;
	return typeof accountUuid === "string" ? accountUuid : "";
}

function getClaudeCodeExtraMetadata(): Record<string, unknown> {
	const extraMetadata = $env.CLAUDE_CODE_EXTRA_METADATA;
	if (!extraMetadata) return {};
	try {
		const parsed = JSON.parse(extraMetadata) as unknown;
		if (isRecord(parsed) && !Array.isArray(parsed)) return parsed;
	} catch {
		return {};
	}
	return {};
}

export function buildAnthropicMetadataUserId(userId: unknown, sessionId: string): AnthropicMetadataUserId {
	const config = readAnthropicMetadataConfig();
	let existing: Record<string, unknown> = {};
	if (typeof userId === "string") {
		try {
			const parsed = JSON.parse(userId) as unknown;
			if (isRecord(parsed) && !Array.isArray(parsed)) {
				existing = parsed;
			}
		} catch {
			existing = {};
		}
	}

	return {
		...existing,
		...getClaudeCodeExtraMetadata(),
		device_id: typeof config.userID === "string" ? config.userID : getOrCreateAnthropicDeviceId(),
		account_uuid: getAnthropicAccountUuid(config),
		session_id: sessionId,
	};
}

export function isAnthropicMetadataUserId(userId: string): boolean {
	try {
		const parsed = JSON.parse(userId) as Partial<AnthropicMetadataUserId>;
		return (
			typeof parsed.device_id === "string" &&
			typeof parsed.account_uuid === "string" &&
			typeof parsed.session_id === "string"
		);
	} catch {
		return false;
	}
}
