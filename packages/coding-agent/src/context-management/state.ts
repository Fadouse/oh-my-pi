import type { NudgeState } from "./nudge";

export interface PendingCheckout {
	targetId: string;
	summaryEntryId: string;
	enrichedMessage: string;
	backupTagApplied: string | undefined;
	origin: string;
	rawTarget: string;
	mode?: "squash" | "jump" | "recover";
	navigateTargetId?: string;
}

const pendingBySession = new Map<string, PendingCheckout>();
const nudgeBySession = new Map<string, NudgeState>();
export const setPending = (sid: string, pending: PendingCheckout): PendingCheckout | undefined => {
	const previous = pendingBySession.get(sid);
	pendingBySession.set(sid, pending);
	return previous;
};

export const peekPending = (sid: string): PendingCheckout | undefined => pendingBySession.get(sid);

export const takePending = (sid: string): PendingCheckout | undefined => {
	const pending = pendingBySession.get(sid);
	pendingBySession.delete(sid);
	return pending;
};

export const peekNudgeState = (sid: string): NudgeState | undefined => nudgeBySession.get(sid);

export const setNudgeState = (sid: string, state: NudgeState): NudgeState | undefined => {
	const previous = nudgeBySession.get(sid);
	nudgeBySession.set(sid, state);
	return previous;
};

export const clearNudgeState = (sid: string): void => {
	nudgeBySession.delete(sid);
};

export const clearSession = (sid: string): void => {
	pendingBySession.delete(sid);
	nudgeBySession.delete(sid);
};

export const clearAllPendingForTests = (): void => {
	pendingBySession.clear();
};

export const clearAllNudgesForTests = (): void => {
	nudgeBySession.clear();
};
