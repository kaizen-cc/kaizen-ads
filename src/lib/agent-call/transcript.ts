import { clock } from "./core";

// A call's transcript as a plain text file to download: the date, who the call was with, then every line with when
// it was said into the call and who said it ("[00:42] Santi: ..."). Pure: the rows come from the call's chat.

export type TranscriptLine = { at: string; who: "user" | "agent"; speaker?: string | null; text: string };

const pad = (s: string) => (s.length < 5 ? s.padStart(5, "0") : s);

/** mm:ss (or h:mm:ss) into the call, never negative */
export function stamp(at: string, startedAt: string): string {
  const s = Math.max(0, Math.floor((Date.parse(at) - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(s)) return "00:00";
  if (s >= 3600) return `${Math.floor(s / 3600)}:${pad(clock(s % 3600))}`;
  return pad(clock(s));
}

export function formatTranscript(input: { startedAt: string; endedAt?: string | null; agentLabel: string; personName: string; lines: TranscriptLine[] }): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(input.startedAt));
  const length = input.endedAt ? ` (${clock((Date.parse(input.endedAt) - Date.parse(input.startedAt)) / 1000)})` : "";
  const head = [`Call with the ${input.agentLabel}`, `${day} New York time${length}`, `${input.personName} and the ${input.agentLabel}`, ""];
  const body = input.lines
    .filter((l) => l.text.trim())
    .map((l) => `[${stamp(l.at, input.startedAt)}] ${l.who === "user" ? input.personName : (l.speaker ?? input.agentLabel)}: ${l.text.replace(/\s+/g, " ").trim()}`);
  return [...head, ...(body.length ? body : ["(Nothing was said on this call.)"]), ""].join("\n");
}

/** The file's name: the agent and the call's day ("call-assistant-2026-11-17.txt") */
export function transcriptFileName(startedAt: string, agentLabel: string): string {
  const day = new Date(startedAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const who = agentLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `call-${who || "agent"}-${day}.txt`;
}
