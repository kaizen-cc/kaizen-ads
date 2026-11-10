import type { SpecAsset } from "./brief-spec";

// The asset heads-up. What a brief is made from: Drive links that open, footage for a video, files the client still
// has to send or shoot. Anything missing makes it "Waiting on assets" (a heads-up that goes with the brief, never a
// hold on sending it), says who to chase, and when the client has to shoot something, whether the due date survives it
// ("Client needs to shoot; due Nov 14 is at risk"). Pure: tested in
// tests/brief-assets.test.ts. The Drive reads and the client's catalogue are gathered on the server.

export type LinkCheck = { url: string; ok: boolean; note?: string | null };
export type GateItem = { label: string; status: "have" | "need" | "shoot" | "missing" | "unreachable"; note: string | null; url?: string | null };
export type AssetGate = {
  state: "ready" | "waiting";
  items: GateItem[];
  /** What's still to come in */
  waiting: GateItem[];
  shoot: boolean;
  /** "Client needs to shoot; due Nov 14 is at risk", or null */
  risk: string | null;
  /** Who to chase, in words ("the client, through Sam (coordinator)") */
  chase: string | null;
  /** Files on the client's Drive whose names or folders look like this concept's */
  driveMatches: number;
};

export type AssetInput = {
  assets: SpecAsset[];
  /** The Drive links in the brief and its references, as read on the server */
  links: LinkCheck[];
  formats: string[];
  /** What the client's Drive catalogue holds (client_assets), and how many files look like this concept's */
  drive: { videos: number; images: number; matching: number };
  /** When it's due (a ticket's due, or a draft's turnaround from today) */
  due: Date | null;
  today: Date;
  /** Who chases the client for it (the client's coordinator), by name */
  chaser?: string | null;
  /** Business days a client shoot needs before the maker can start */
  shootDays?: number;
};

const DRIVE = /https?:\/\/(?:drive|docs)\.google\.com\/\S+/gi;
/** Every Drive link in a text */
export const driveLinks = (text: string) => [...new Set((text.match(DRIVE) ?? []).map((u) => u.replace(/[).,;]+$/, "")))];

/** Business days from a day to another (weekends skipped); negative when it's already past */
export function businessDaysBetween(from: Date, to: Date) {
  const a = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate()));
  const b = new Date(Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()));
  const sign = b >= a ? 1 : -1;
  let n = 0;
  const d = new Date(a);
  while (sign > 0 ? d < b : d > b) {
    d.setUTCDate(d.getUTCDate() + sign);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) n += sign;
  }
  return n;
}

/** A day some business days after another */
export function addBusinessDays(from: Date, days: number) {
  const d = new Date(from);
  let n = 0;
  while (n < days) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) n++;
  }
  return d;
}

export const shortDay = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function assetGate(i: AssetInput): AssetGate {
  const items: GateItem[] = [];
  const linkOf = (s: string) => driveLinks(s)[0] ?? null;
  for (const a of i.assets) {
    const url = linkOf(a.item);
    const read = url ? i.links.find((l) => l.url === url) : null;
    if (url && read && !read.ok) items.push({ label: a.item, status: "unreachable", note: read.note ?? "The link doesn't open for Kaizen's Drive.", url });
    else if (/\b(MISSING|TBD|TBC)\b/.test(a.item)) items.push({ label: a.item.replace(/\s*[:-]?\s*\b(MISSING|TBD|TBC)\b/g, "").trim() || "A Drive link", status: "missing", note: "No link yet.", url });
    else items.push({ label: a.item, status: a.status, note: null, url });
  }
  // Links in the brief or references that don't open, not already listed
  for (const l of i.links) if (!l.ok && !items.some((x) => x.url === l.url)) items.push({ label: "Drive link", status: "unreachable", note: l.note ?? "The link doesn't open for Kaizen's Drive.", url: l.url });
  // A video with no footage: not on Drive and not listed as had
  const hasFootage = i.assets.some((a) => a.status === "have" && /\b(footage|video|clip|b-?roll|reel)s?\b/i.test(a.item)) || i.drive.videos > 0;
  if (i.formats.includes("video") && !hasFootage && !items.some((x) => x.status !== "have" && /\b(footage|video|clip|film|shoot)\b/i.test(x.label)))
    items.push({ label: "Footage for the video", status: "need", note: "Nothing on the client's Drive is video yet.", url: null });

  const waiting = items.filter((x) => x.status !== "have");
  const shoot = waiting.some((x) => x.status === "shoot");
  let risk: string | null = null;
  if (shoot && i.due) {
    const left = businessDaysBetween(i.today, i.due);
    if (left < (i.shootDays ?? 5)) risk = `Client needs to shoot; due ${shortDay(i.due)} is at risk`;
  } else if (waiting.length && i.due && businessDaysBetween(i.today, i.due) <= 1) risk = `Assets aren't in; due ${shortDay(i.due)} is at risk`;
  const chase = waiting.length ? (i.chaser ? `the client, through ${i.chaser}` : "the client, through their coordinator") : null;
  return { state: waiting.length ? "waiting" : "ready", items, waiting, shoot, risk, chase, driveMatches: i.drive.matching };
}
