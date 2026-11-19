// What someone was typing to their assistant (or in a Kaizen AI thread), kept on this device until it's sent or
// deleted: minimising, closing, reopening the chat or moving to another page never loses it. Also how big they like
// the chat window. Everything is per person (and per thread for drafts); storage that's blocked (a private window)
// just means nothing is remembered.

/** The bits of a draft kept: the words, and attachments already uploaded (their stored paths, not the files) */
export type StoredDraft<A = unknown> = { text: string; attachments: A[]; at: number };

/** A draft older than this is dropped when read (a stale half-message from weeks ago isn't wanted back) */
export const DRAFT_TTL_MS = 30 * 86_400_000;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const storage = (): Store | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

export const chatDraftKey = (personId: string | null | undefined, thread: string) => `kz:draft:${personId || "me"}:${thread}`;
export const chatSizeKey = (personId: string | null | undefined) => `kz:chat-size:${personId || "me"}`;

/** Read a draft: empty when there is none, it's unreadable, or it's too old */
export function readDraft<A = unknown>(key: string, now = Date.now(), store: Store | null = storage()): StoredDraft<A> {
  const empty: StoredDraft<A> = { text: "", attachments: [], at: 0 };
  if (!store) return empty;
  try {
    const raw = store.getItem(key);
    if (!raw) return empty;
    const d = JSON.parse(raw) as Partial<StoredDraft<A>>;
    const at = typeof d.at === "number" ? d.at : 0;
    if (now - at > DRAFT_TTL_MS) {
      store.removeItem(key);
      return empty;
    }
    return { text: typeof d.text === "string" ? d.text : "", attachments: Array.isArray(d.attachments) ? d.attachments : [], at };
  } catch {
    return empty;
  }
}

/** Keep a draft (an empty one is removed, so a sent or deleted message leaves nothing behind) */
export function writeDraft<A = unknown>(key: string, text: string, attachments: A[] = [], now = Date.now(), store: Store | null = storage()): void {
  if (!store) return;
  try {
    if (!text.trim() && !attachments.length) store.removeItem(key);
    else store.setItem(key, JSON.stringify({ text, attachments, at: now } satisfies StoredDraft<A>));
  } catch {
    /* full or blocked: not remembered */
  }
}

export function clearDraft(key: string, store: Store | null = storage()): void {
  try {
    store?.removeItem(key);
  } catch {
    /* blocked */
  }
}

export type ChatSize = "dock" | "large";

export function readChatSize(key: string, store: Store | null = storage()): ChatSize {
  try {
    return store?.getItem(key) === "large" ? "large" : "dock";
  } catch {
    return "dock";
  }
}

export function writeChatSize(key: string, size: ChatSize, store: Store | null = storage()): void {
  try {
    if (size === "large") store?.setItem(key, "large");
    else store?.removeItem(key);
  } catch {
    /* blocked */
  }
}
