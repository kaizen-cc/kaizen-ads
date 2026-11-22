// Pictures pasted, dropped or attached in an AI chat: the browser shrinks each to a JPEG data URL (src/components/chat-images.tsx)
// and sends them with the message; the server turns them into image blocks for the model. Plain module: safe from actions.

export const CHAT_IMAGE_MAX = 6;
/** Per picture, in characters of the data URL (the browser shrinks to fit; six fit inside a 4.5 MB action body) */
export const CHAT_IMAGE_CHARS = 600_000;

export type ChatImage = { mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string };

const TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

/** Data URLs from the browser, checked and split into what the model takes. Anything that isn't a small picture is dropped. */
export function chatImagesFrom(urls: unknown): ChatImage[] {
  if (!Array.isArray(urls)) return [];
  const out: ChatImage[] = [];
  for (const u of urls) {
    if (typeof u !== "string" || u.length > CHAT_IMAGE_CHARS * 2) continue;
    const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(u);
    const type = TYPES.find((t) => t === m?.[1]);
    if (!m || !type) continue;
    out.push({ mediaType: type, data: m[2] });
    if (out.length >= CHAT_IMAGE_MAX) break;
  }
  return out;
}

/** A line to add to the prompt so the model knows the pictures are the person's screenshots */
export const imagesNote = (n: number) => (n ? `\n\n(${n} picture${n === 1 ? " is" : "s are"} attached with this message: the person's screenshot${n === 1 ? "" : "s"}. Look at ${n === 1 ? "it" : "them"} and answer from what you see.)` : "");
