/** Terminal-stop kinds Pi accepts from pi-continue-watchdog. Human aborts are not. */

const VALID_STOP_KINDS = new Set(["AI_UNLOCK", "ERROR_UNLOCK", "EXHAUSTED", "DECISION_FAILED"]);

export function parseUserReady(data) {
	if (!data || typeof data !== "object") return undefined;
	const kind = data.stopKind;
	if (typeof kind !== "string" || !VALID_STOP_KINDS.has(kind)) return undefined;
	const out = { stopKind: kind };
	if (typeof data.reasonType === "string" && data.reasonType.trim()) out.reasonType = data.reasonType;
	if (typeof data.reason === "string" && data.reason.trim()) out.reason = data.reason;
	return out;
}
