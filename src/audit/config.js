/**
 * Audit config. Defaults match the user's Pi setup
 * (~/.pi/agent/jev-todo-audit.json sets only apiKey; settings.retry
 * maxRetries 10, baseDelayMs default 2000).
 *
 * Key order: env (TYPESAFE_API_KEY) wins, then cordis `apiKey`, then the
 * Pi global file. The file is read at runtime and never logged.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_AUDIT = {
	enabled: true,
	interval: 10,
	cooldownLoops: 10,
	confidenceThreshold: 0.5,
	model: "jev-latest",
	apiKeyEnvVar: "TYPESAFE_API_KEY",
	apiUrl: "https://api.typesafe.ai/v1/systemone",
	timeoutMs: 30_000,
	notifyOnAligned: false,
	staleAuditSpans: 3,
	maxRetries: 10,
	baseDelayMs: 2000,
};

function num(v, fallback, min) {
	return typeof v === "number" && Number.isFinite(v) && v >= min ? v : fallback;
}

function str(v) {
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function resolveAuditConfig(input = {}) {
	const d = DEFAULT_AUDIT;
	return {
		enabled: typeof input.enabled === "boolean" ? input.enabled : d.enabled,
		interval: num(input.interval, d.interval, 1),
		cooldownLoops: num(input.cooldownLoops, d.cooldownLoops, 0),
		confidenceThreshold: num(input.confidenceThreshold, d.confidenceThreshold, 0),
		model: str(input.model) ?? d.model,
		apiKeyEnvVar: str(input.apiKeyEnvVar) ?? d.apiKeyEnvVar,
		apiKey: str(input.apiKey),
		apiUrl: str(input.apiUrl) ?? d.apiUrl,
		timeoutMs: num(input.timeoutMs, d.timeoutMs, 1000),
		notifyOnAligned: typeof input.notifyOnAligned === "boolean" ? input.notifyOnAligned : d.notifyOnAligned,
		staleAuditSpans: num(input.staleAuditSpans, d.staleAuditSpans, 1),
		maxRetries: num(input.maxRetries, d.maxRetries, 0),
		baseDelayMs: num(input.baseDelayMs, d.baseDelayMs, 0),
		activityBudgetChars: typeof input.activityBudgetChars === "number" ? input.activityBudgetChars : undefined,
		// ponytail: no trusted-project layer. Pi only merges <cwd>/.pi/jev-todo-audit.json when isProjectTrusted().
		readPiKeyFile: input.readPiKeyFile !== false,
	};
}

/** Pi global key file. Blank/missing/malformed → undefined. Never throws. */
export function readPiApiKey(env = process.env) {
	const dir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	try {
		const raw = JSON.parse(readFileSync(join(dir, "jev-todo-audit.json"), "utf8"));
		return str(raw?.apiKey);
	} catch {
		return undefined;
	}
}

/** Env wins over cordis config, then the Pi file. */
export function resolveApiKey(cfg, env = process.env) {
	const fromEnv = str(env[cfg.apiKeyEnvVar]);
	if (fromEnv) return fromEnv;
	if (cfg.apiKey) return cfg.apiKey;
	if (cfg.readPiKeyFile) return readPiApiKey(env);
	return undefined;
}
