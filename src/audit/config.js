/**
 * Audit config. Defaults: jev-latest, interval 10, cooldown 10, retry
 * maxRetries 10 / baseDelayMs 2000.
 *
 * Key order: the DSH credentials service (`apiKeyEnvVar`, default
 * TYPESAFE_API_KEY; it layers the launch environment over
 * $DSH_HOME/.credentials.yaml), then the process environment when no
 * credentials service exists, then cordis `apiKey`. Never logged.
 */

import { credentialRef } from "@deepseek-ai/dsh-credentials";

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
	};
}

/**
 * @param cfg resolved audit config
 * @param credentials `ctx.get("credentials")`, or undefined outside a DSH host
 * @param env process environment, used only without a credentials service
 */
export async function resolveApiKey(cfg, credentials, env = process.env) {
	if (credentials) {
		const hit = await credentials.resolve(credentialRef(cfg.apiKeyEnvVar));
		const stored = str(hit?.value);
		if (stored) return stored;
	} else {
		const fromEnv = str(env[cfg.apiKeyEnvVar]);
		if (fromEnv) return fromEnv;
	}
	return cfg.apiKey;
}
