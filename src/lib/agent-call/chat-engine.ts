import type { CallCard, CallEvent, CallProgress, LearnedItem, UploadAsk } from "./core";
import type { CallContext } from "./call-context";
import type { Speaker } from "./engine";
import type { JobView } from "@/lib/assistant/team";

// The chat with the assistant, in the browser: the same turns as a call (the same /api/agent-call/turn, the same
// events: who's speaking, cards, the job, uploads, a look, screens it opens, a goodbye, moving to a call), only typed
// in and read out as it streams instead of spoken. It knows nothing about screens; the call provider owns one and the
// chat window reads its state. Turns go one at a time, in order (a second message waits for the first answer).

/** A line of the chat. `streaming` while the agent is still writing it; `note` for a line the person didn't type (an upload) */
export type ChatLine = { id: number; who: "you" | "agent"; text: string; speaker?: Speaker | null; streaming?: boolean; note?: boolean; /** Pictures they pasted or attached with this message (local previews) */ images?: string[]; /** Sent while an answer was still being written: waits its turn, can be taken back until then */ queued?: boolean };

export type ChatHooks = {
  /** A line was added or changed (matched by id) */
  onLine: (l: ChatLine) => void;
  /** A queued message taken back before its turn */
  onRemove?: (id: number) => void;
  onBusy: (busy: boolean) => void;
  onError: (msg: string | null) => void;
  onLearned?: (items: LearnedItem[]) => void;
  onTeam?: (line: Speaker[]) => void;
  onJob?: (job: JobView | null) => void;
  /** What the agent is working on now: a status line with a step bar, not a message (null: done) */
  onProgress?: (p: CallProgress | null) => void;
  onNavigate?: (href: string) => void;
  onCard?: (c: CallCard) => void;
  onUpload?: (ask: UploadAsk) => void;
  onLook?: () => void;
  /** The agent ended on a goodbye */
  onEnd?: () => void;
  /** The agent moved the conversation to a call */
  onSwitch?: (to: "voice" | "text") => void;
};

const STALL_MS = 90_000;

export class ChatSession {
  callId = "";
  context: CallContext | null = null;
  private lineId: number;
  private queue: Promise<void> = Promise.resolve();
  private turn: AbortController | null = null;
  private closed = false;
  private pending = 0;
  /** Queued messages not answered yet (by their line id), and the ones taken back */
  private waiting = new Map<number, ChatLine>();
  private dropped = new Set<number>();

  /** `firstId`: line ids continue after the history already shown */
  constructor(
    private hooks: ChatHooks,
    firstId = 0,
  ) {
    this.lineId = firstId;
  }

  /** A typed message: shown at once, answered in order */
  send(text: string) {
    const t = text.trim();
    if (!t || this.closed) return;
    // While an answer is being written it waits its turn, shown as queued (and can be taken back until then)
    const line: ChatLine = { id: ++this.lineId, who: "you", text: t, ...(this.pending > 0 ? { queued: true } : {}) };
    this.hooks.onLine(line);
    this.enqueue(t, null, line);
  }

  /** A message with pictures they pasted or attached: shown with its previews, the first picture seen with the turn */
  sendWithPictures(text: string, said: string, frame: string | null, images: string[]) {
    if (this.closed) return;
    this.hooks.onLine({ id: ++this.lineId, who: "you", text: text.trim(), images });
    this.enqueue(said, frame);
  }

  /** A turn the person didn't type (files they uploaded, a screenshot): shown as a short note, answered like a message */
  inject(text: string, shown: string, frame: string | null = null) {
    if (this.closed) return;
    this.hooks.onLine({ id: ++this.lineId, who: "you", text: shown, note: true });
    this.enqueue(text, frame);
  }

  /** Take back a queued message before its turn (it leaves the thread); false when it has already started */
  unqueue(id: number): string | null {
    const line = this.waiting.get(id);
    if (!line) return null;
    this.waiting.delete(id);
    this.dropped.add(id);
    this.hooks.onRemove?.(id);
    return line.text;
  }

  /** Stop the answer being written (what's written so far stays) */
  stop() {
    this.turn?.abort();
  }

  close() {
    this.closed = true;
    this.turn?.abort();
  }

  private enqueue(text: string, frame: string | null, line?: ChatLine) {
    this.pending++;
    this.hooks.onBusy(true);
    if (line?.queued) this.waiting.set(line.id, line);
    this.queue = this.queue
      .then(() => {
        if (line && this.dropped.has(line.id)) return;
        if (line?.queued) {
          this.waiting.delete(line.id);
          this.hooks.onLine({ ...line, queued: false });
        }
        return this.ask(text, frame);
      })
      .catch(() => undefined)
      .finally(() => {
        this.pending--;
        if (this.pending === 0 && !this.closed) this.hooks.onBusy(false);
      });
  }

  private async ask(said: string, frame: string | null) {
    if (this.closed) return;
    const turn = new AbortController();
    this.turn = turn;
    this.hooks.onError(null);
    let current: ChatLine | null = null;
    let speaker: Speaker | null = null;
    let ending = false;
    let switching: "voice" | "text" | null = null;
    // A line is opened by the first words after a speaker change
    const write = (d: string) => {
      if (!current) {
        if (!d.trim()) return;
        current = { id: ++this.lineId, who: "agent", text: "", speaker, streaming: true };
      }
      current = { ...current, text: current.text + d };
      this.hooks.onLine(current);
    };
    const finish = () => {
      if (!current) return;
      const text = current.text.trim();
      current = { ...current, text, streaming: false };
      this.hooks.onLine(current);
      current = null;
    };
    let stall: ReturnType<typeof setTimeout> | null = null;
    const watch = () => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(() => turn.abort(), STALL_MS);
    };
    watch();
    try {
      const res = await fetch("/api/agent-call/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callId: this.callId, mode: "text", text: said, path: `${window.location.pathname}${window.location.search}`.slice(0, 500), ...(this.context ? { context: this.context } : {}), ...(frame ? { frame } : {}) }),
        signal: turn.signal,
      });
      if (res.status === 410) {
        this.hooks.onError("This chat has ended. Start a new one.");
        return;
      }
      if (!res.ok || !res.body) throw new Error(String(res.status));
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let rest = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        watch();
        rest += dec.decode(value, { stream: true });
        const parts = rest.split("\n");
        rest = parts.pop() ?? "";
        for (const l of parts) {
          if (!l.trim()) continue;
          let e: CallEvent;
          try {
            e = JSON.parse(l) as CallEvent;
          } catch {
            continue;
          }
          if (e.t === "text") write(e.d);
          else if (e.t === "speaker") {
            finish();
            speaker = { role: e.role, label: e.label, icon: e.icon };
          } else if (e.t === "error") {
            finish();
            write(e.message);
            finish();
          } else if (e.t === "learned") this.hooks.onLearned?.(e.items);
          else if (e.t === "team") this.hooks.onTeam?.(e.line);
          else if (e.t === "job") this.hooks.onJob?.(e.job);
          else if (e.t === "progress") this.hooks.onProgress?.(e.progress);
          else if (e.t === "navigate") this.hooks.onNavigate?.(e.href);
          else if (e.t === "page" && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("kaizen-page", { detail: { name: e.name, detail: e.detail } }));
          else if (e.t === "card") this.hooks.onCard?.(e.card);
          else if (e.t === "upload") this.hooks.onUpload?.(e.ask);
          else if (e.t === "look") this.hooks.onLook?.();
          else if (e.t === "end") ending = true;
          else if (e.t === "switch") switching = e.to;
        }
      }
    } catch {
      if (!turn.signal.aborted || this.closed) {
        if (!this.closed) this.hooks.onError("That didn't go through. Send it again?");
      }
    } finally {
      if (stall) clearTimeout(stall);
      this.hooks.onProgress?.(null);
      finish();
      if (this.turn === turn) this.turn = null;
    }
    if (this.closed) return;
    if (ending) this.hooks.onEnd?.();
    else if (switching) this.hooks.onSwitch?.(switching);
  }
}
