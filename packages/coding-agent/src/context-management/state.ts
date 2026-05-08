export interface PendingCheckout {
	targetId: string;
	summaryEntryId: string;
	enrichedMessage: string;
	backupTagApplied: string | undefined;
	origin: string;
	rawTarget: string;
}

const pendingBySession = new Map<string, PendingCheckout>();

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

export const clearSession = (sid: string): void => {
	pendingBySession.delete(sid);
};

export const clearAllPendingForTests = (): void => {
	pendingBySession.clear();
};
