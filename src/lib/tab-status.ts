"use client";

// A dot on the Kaizen OS tab's icon while the assistant or Kaizen AI works on something (Kyle, Nov 23 2026): grey while
// it's thinking, green when the answer is in, yellow when it ends on a question for you, red if it failed. Ask, go to
// another tab, and the tab tells you when to come back. A finished state clears once you're back on the tab.

export type TabState = "thinking" | "done" | "question" | "error";

const COLOR: Record<TabState, string> = { thinking: "#9ca3af", done: "#22c55e", question: "#f2b14c", error: "#ef4444" };
// What shows when several things are going on: what needs you first
const RANK: TabState[] = ["question", "error", "done", "thinking"];

const states = new Map<string, TabState>();
let originals: { el: HTMLLinkElement; href: string }[] | null = null;
let base: HTMLImageElement | null = null;
let drawn: TabState | null = null;
let listening = false;

/** An answer that ends by asking them something */
export const endsWithQuestion = (text: string) => /\?["')\]*_\s]*$/.test(text.trim());

/** What the answer to a request came to, for the dot */
export const answerState = (text: string, failed = false): TabState => (failed ? "error" : endsWithQuestion(text) ? "question" : "done");

const watching = () => typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();

/** Set (or with null, clear) one source's state: "assistant", "kaizen-ai" */
export function setTabStatus(source: string, state: TabState | null) {
  if (typeof document === "undefined") return;
  listen();
  // Finished while they're looking right at it: nothing to call them back for
  if (state && state !== "thinking" && watching()) state = null;
  if (state) states.set(source, state);
  else states.delete(source);
  void paint();
}

function listen() {
  if (listening) return;
  listening = true;
  const back = () => {
    if (!watching()) return;
    for (const [k, v] of states) if (v !== "thinking") states.delete(k);
    void paint();
  };
  document.addEventListener("visibilitychange", back);
  window.addEventListener("focus", back);
}

function icons(): HTMLLinkElement[] {
  return [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
}

async function paint() {
  const top = RANK.find((r) => [...states.values()].includes(r)) ?? null;
  if (top === drawn) return;
  drawn = top;
  if (!originals) originals = icons().map((el) => ({ el, href: el.href }));
  if (!top) {
    for (const o of originals) o.el.href = o.href;
    return;
  }
  try {
    if (!base) {
      const img = new Image();
      img.src = "/icon.png";
      await img.decode();
      base = img;
    }
    if (drawn !== top) return;
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    if (!g) return;
    g.drawImage(base, 0, 0, 64, 64);
    g.beginPath();
    g.arc(48, 48, 15, 0, Math.PI * 2);
    g.fillStyle = "#0b0b0c";
    g.fill();
    g.beginPath();
    g.arc(48, 48, 11, 0, Math.PI * 2);
    g.fillStyle = COLOR[top];
    g.fill();
    const url = c.toDataURL("image/png");
    const links = icons();
    if (!links.length) {
      const l = document.createElement("link");
      l.rel = "icon";
      document.head.appendChild(l);
      links.push(l);
    }
    for (const l of links) l.href = url;
  } catch {
    // No icon to draw on: leave the tab as it is
  }
}
