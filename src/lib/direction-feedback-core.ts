// The client's own feedback, carried whole into what the makers read (owner + Head of Email, Nov 24 2026: the client
// linked assets in her Slack message and the links never reached the Asana comment). Every comment posted when
// feedback is applied quotes the client's full original message with every link clickable (Drive, Figma, Loom...),
// who said it and when, where (with a permalink to the message), and the files they attached (attached to the task, or
// linked when too big). Pure: tested in tests/direction-feedback.test.ts.

export type Feedback = {
  author: string;
  /** ISO time it was said */
  at: string | null;
  /** "Slack", "Email", "Portal chat", "Call" */
  where: string;
  /** The message as written (Slack's own markup is read: <url|label>, <url>, <@U123>, *bold*) */
  text: string;
  permalink: string | null;
  files: FeedbackFile[];
};
export type FeedbackFile = { name: string; url: string | null; size: number | null; mime: string | null };
export type Attached = { name: string; url: string | null };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Every link in the message, in order (Slack's <url|label> and <url>, and bare URLs), once each */
export function linksIn(text: string): { url: string; label: string }[] {
  const out: { url: string; label: string }[] = [];
  const seen = new Set<string>();
  const add = (url: string, label: string) => {
    const u = url.replace(/&amp;/g, "&").trim();
    if (!/^https?:\/\//i.test(u) || seen.has(u)) return;
    seen.add(u);
    out.push({ url: u, label: label.trim() || u });
  };
  const slack = /<(https?:\/\/[^|>\s]+)(?:\|([^>]*))?>/g;
  for (const m of text.matchAll(slack)) add(m[1], m[2] ?? "");
  const bare = text.replace(slack, " ").matchAll(/https?:\/\/[^\s<>"')\]]+/g);
  for (const m of bare) add(m[0].replace(/[.,;:!?]+$/, ""), "");
  return out;
}

/** The message as plain text people read: Slack links become "label (url)", mentions and markup cleaned */
export function plainMessage(text: string): string {
  return text
    .replace(/<(https?:\/\/[^|>\s]+)\|([^>]*)>/g, (_, u: string, l: string) => (l.trim() && l.trim() !== u ? `${l.trim()} (${u.replace(/&amp;/g, "&")})` : u.replace(/&amp;/g, "&")))
    .replace(/<(https?:\/\/[^>\s]+)>/g, (_, u: string) => u.replace(/&amp;/g, "&"))
    .replace(/<@[A-Z0-9]+(?:\|([^>]+))?>/g, (_, n?: string) => (n ? `@${n}` : "@someone"))
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

/** The message as Asana rich text: links clickable, line breaks kept, Slack's *bold* and _italics_ */
export function htmlMessage(text: string): string {
  const parts: string[] = [];
  let last = 0;
  const re = /<(https?:\/\/[^|>\s]+)(?:\|([^>]*))?>|https?:\/\/[^\s<>"')\]]+/g;
  const plain = (s: string) =>
    esc(plainMessage(s))
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, "$1<strong>$2</strong>")
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, "$1<em>$2</em>");
  for (const m of text.matchAll(re)) {
    parts.push(plain(text.slice(last, m.index)));
    const url = (m[1] ?? m[0]).replace(/&amp;/g, "&").replace(/[.,;:!?]+$/, "");
    const tail = m[1] ? "" : m[0].slice(url.length);
    const label = (m[2] ?? "").trim() || url;
    parts.push(`<a href="${esc(url)}">${esc(label)}</a>${esc(tail)}`);
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(plain(text.slice(last)));
  return parts.join("");
}

export const whenSaid = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" }) : null;

/** "Britt Engler in Slack, Nov 24, 2026, 1:14 PM EST" */
export const saidBy = (f: Pick<Feedback, "author" | "where" | "at">) => [`${f.author} in ${f.where}`, whenSaid(f.at)].filter(Boolean).join(", ");

/**
 * The Asana comment (rich text): what to do (the note's lines), then the client's feedback whole: who, where and
 * when, their message quoted with every link clickable, the links listed again so none is missed, the files, and the
 * link to the message itself.
 */
export function feedbackCommentHtml(note: string, f: Feedback | null, files: Attached[] = [], footer: string | null = null): string {
  const lines = note.split("\n").filter((l) => l.trim());
  const body: string[] = [lines.map((l, i) => (i === 0 ? `<strong>${esc(l)}</strong>` : esc(l))).join("\n")];
  if (f) {
    body.push("", `<strong>The client's feedback</strong> (${esc(saidBy(f))}):`, `<blockquote>${htmlMessage(f.text)}</blockquote>`);
    const links = linksIn(f.text);
    if (links.length) body.push(`<strong>Links they shared</strong>`, `<ul>${links.map((l) => `<li><a href="${esc(l.url)}">${esc(l.label)}</a></li>`).join("")}</ul>`);
    const all = [...files, ...f.files.filter((x) => !files.some((a) => a.name === x.name)).map((x) => ({ name: x.name, url: x.url }))];
    if (all.length) body.push(`<strong>Files they attached</strong>`, `<ul>${all.map((x) => `<li>${x.url ? `<a href="${esc(x.url)}">${esc(x.name)}</a>` : `${esc(x.name)} (attached to this task)`}</li>`).join("")}</ul>`);
    if (f.permalink) body.push(`<a href="${esc(f.permalink)}">Open the message in ${esc(f.where)}</a>`);
  }
  if (footer) body.push("", `<em>${esc(footer)}</em>`);
  return `<body>${body.join("\n")}</body>`;
}

/** The same, as plain text (a Kaizen ticket's timeline) */
export function feedbackCommentText(note: string, f: Feedback | null): string {
  if (!f) return note;
  const links = linksIn(f.text);
  return [
    note,
    "",
    `The client's feedback (${saidBy(f)}):`,
    `"${plainMessage(f.text)}"`,
    ...(links.length ? ["", "Links they shared:", ...links.map((l) => `- ${l.label === l.url ? l.url : `${l.label}: ${l.url}`}`)] : []),
    ...(f.files.length ? ["", "Files they attached:", ...f.files.map((x) => `- ${x.name}${x.url ? `: ${x.url}` : ""}`)] : []),
    ...(f.permalink ? ["", `Message: ${f.permalink}`] : []),
  ].join("\n");
}

/** "slack_external:C0CGC6E24NQ:1795544055.157809#0" → where the original message lives */
export function sourceOf(ref: string | null): { kind: "context"; source: string; externalId: string } | { kind: "portal"; id: string } | { kind: "call"; id: string } | null {
  const r = String(ref ?? "").replace(/#\d+$/, "");
  const m = r.match(/^(slack_external|gmail):(.+)$/);
  if (m) return { kind: "context", source: m[1], externalId: m[2] };
  const p = r.match(/^portal:(.+)$/);
  if (p) return { kind: "portal", id: p[1] };
  const c = r.match(/^call:(.+)$/);
  if (c) return { kind: "call", id: c[1] };
  return null;
}

/** What the "Apply all" preview says it will do, before anything happens */
export function applyPreview(tasks: { title: string; asana: boolean; to: string | null; how: "send_back" | "keep" | "stop" }[]): string[] {
  const asana = tasks.filter((t) => t.asana && t.how !== "keep");
  const moved = tasks.filter((t) => t.how === "send_back" && t.to);
  const stages = [...new Set(moved.map((t) => t.to as string))];
  const out: string[] = [];
  if (asana.length) out.push(`Post ${asana.length === 1 ? "1 comment" : `${asana.length} comments`} on ${asana.length === 1 ? "this Asana task" : "these Asana tasks"}, as you, with the client's full feedback, links and files`);
  const kaizen = tasks.filter((t) => !t.asana && t.how !== "keep").length;
  if (kaizen) out.push(`Add the note to ${kaizen === 1 ? "1 Kaizen ticket" : `${kaizen} Kaizen tickets`}`);
  if (stages.length) out.push(`Send ${moved.length === 1 ? "it" : "them"} back to ${stages.join(", ")} for review`);
  const stopped = tasks.filter((t) => t.how === "stop").length;
  if (stopped) out.push(`Stop ${stopped === 1 ? "1 task" : `${stopped} tasks`}`);
  out.push("Nothing goes to the client");
  return out;
}
