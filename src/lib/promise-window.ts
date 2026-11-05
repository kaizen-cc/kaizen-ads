// Promises from calls only count while they're recent: Asana shows what's in motion, not what was finished long ago,
// so a promise from an older call can't be told apart from one we delivered. The owner's rule (Nov 2026): 90 days.
export const PROMISE_WINDOW_DAYS = 90;

/** The earliest call date whose promises still show (ISO) */
export const promiseSince = () => new Date(Date.now() - PROMISE_WINDOW_DAYS * 86_400_000).toISOString();
