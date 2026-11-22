"use client";

import { useCallback, useState, type ClipboardEvent, type DragEvent } from "react";
import { callUploadSlots, callUploadsDone } from "@/app/(team)/assistant/actions";
import type { ChatSession } from "@/lib/agent-call/chat-engine";
import { CHAT_IMAGE_CHARS, CHAT_IMAGE_MAX } from "@/lib/chat-images";
import { createClient } from "@/lib/supabase/client";

/** A picture made smaller (at most 1600px wide, JPEG) so it sends fast, or null when it can't be made small enough. */
function shrink(source: CanvasImageSource, w: number, h: number) {
  let width = Math.min(1600, w);
  let quality = 0.8;
  for (let i = 0; i < 6; i++) {
    const height = Math.max(1, Math.round((h * width) / w));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(source, 0, 0, width, height);
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.length < CHAT_IMAGE_CHARS) return url;
    width = Math.round(width * 0.8);
    quality = Math.max(0.5, quality - 0.07);
  }
  return null;
}

async function toDataUrl(file: File) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return shrink(img, img.naturalWidth, img.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Pictures for the next message in an AI chat: paste (Ctrl/Cmd+V), drop or the paperclip. Spread `box` on the textarea
 * (or its wrapper), render <ChatImageStrip /> above it and <AttachButton /> beside it; send `urls` with the message
 * (the server reads them with chatImagesFrom) and call clear() once it's sent.
 */
export function useChatImages() {
  const [urls, setUrls] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const add = useCallback(async (files: File[]) => {
    const pics = files.filter((f) => f.type.startsWith("image/"));
    if (!pics.length) return;
    setError(null);
    const made: string[] = [];
    for (const f of pics) {
      try {
        const u = await toDataUrl(f);
        if (u) made.push(u);
        else setError("That picture is too big to send.");
      } catch {
        setError("That picture couldn't be added. Try a PNG or JPEG.");
      }
    }
    setUrls((cur) => {
      if (cur.length + made.length > CHAT_IMAGE_MAX) setError(`Up to ${CHAT_IMAGE_MAX} pictures per message.`);
      return [...cur, ...made].slice(0, CHAT_IMAGE_MAX);
    });
  }, []);

  const box = {
    onPaste: (e: ClipboardEvent) => {
      const pics = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
      if (!pics.length) return;
      e.preventDefault();
      void add(pics);
    },
    onDragOver: (e: DragEvent) => {
      if ([...e.dataTransfer.types].includes("Files")) {
        e.preventDefault();
        setOver(true);
      }
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => {
      setOver(false);
      const pics = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
      if (!pics.length) return;
      e.preventDefault();
      void add(pics);
    },
  };

  return {
    urls,
    error,
    over,
    box,
    add,
    remove: (i: number) => setUrls((cur) => cur.filter((_, j) => j !== i)),
    clear: () => {
      setUrls([]);
      setError(null);
    },
    /** Put pictures back (a send that failed) */
    restore: (u: string[]) => setUrls(u),
  };
}

export type ChatImagesState = ReturnType<typeof useChatImages>;

/** Small thumbnails with × above the input; nothing when there are none */
export function ChatImageStrip({ chat }: { chat: ChatImagesState }) {
  if (!chat.urls.length && !chat.error) return null;
  return (
    <div className="grid gap-1.5">
      {chat.urls.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {chat.urls.map((u, i) => (
            <li key={i} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt={`Attached picture ${i + 1}`} className="h-14 w-14 rounded-[10px] border border-line object-cover" />
              <button
                type="button"
                onClick={() => chat.remove(i)}
                aria-label={`Remove picture ${i + 1}`}
                className="absolute -right-2 -top-2 grid h-6 w-6 place-items-center rounded-full border border-line bg-surface text-xs text-fg shadow-sm before:absolute before:-inset-2.5 before:content-['']"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {chat.error && <p className="text-xs text-bad">{chat.error}</p>}
    </div>
  );
}

/** The paperclip: opens the picture picker (44px on phones) */
export function AttachButton({ chat, disabled }: { chat: ChatImagesState; disabled?: boolean }) {
  return (
    <label
      title="Attach a picture (or paste a screenshot)"
      className={`grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-[12px] border border-line text-muted focus-within:border-brand-text/60 hover:border-faint hover:text-fg md:h-10 md:w-10 ${disabled ? "pointer-events-none opacity-40" : ""}`}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m21 11.5-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" />
      </svg>
      <input
        type="file"
        accept="image/*"
        multiple
        aria-label="Attach a picture"
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          void chat.add([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </label>
  );
}

/**
 * Send a message with pictures through a live ChatSession (the pipeline behind calls and the assistant's chat): the
 * pictures go up with the call's files, so later turns know them, and the first is seen with this turn.
 */
export async function sendPicturesThrough(session: ChatSession, text: string, urls: string[]) {
  const files = await Promise.all(
    urls.map(async (u, i) => new File([await (await fetch(u)).blob()], `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}${i ? `-${i + 1}` : ""}.jpg`, { type: "image/jpeg" })),
  );
  const slots = await callUploadSlots(session.callId, files.map((f) => ({ name: f.name, mime: f.type, bytes: f.size, frames: 0 })));
  if (!slots.ok) throw new Error(slots.error);
  const supabase = createClient();
  await Promise.all(
    files.map(async (f, i) => {
      const { error } = await supabase.storage.from("ai-files").uploadToSignedUrl(slots.slots[i].path, slots.slots[i].token, f, { contentType: f.type });
      if (error) throw new Error("A picture didn't upload.");
    }),
  );
  const done = await callUploadsDone(session.callId, files.map((f, i) => ({ path: slots.slots[i].path, name: f.name, mime: f.type, bytes: f.size })), "files", null);
  if (!done.ok) throw new Error(done.error);
  const said = `${text.trim() || "Take a look at this."}\n\n(Attached: ${done.files.map((f) => f.name).join(", ")}.${done.files.length > 1 ? " The first picture is shown with this message; the others are described with the files from this conversation." : ""})`;
  session.sendWithPictures(text.trim(), said, done.files[0]?.path ?? null, urls);
}
