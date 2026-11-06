// The Brand Bible's avatars (its audience profiles) and how they change: added, changed or retired only through an
// approved proposal. A changed or retired avatar is never removed: it stays in the Bible, labeled retired with the day.
// Plain functions (no server or browser APIs), shared by the server actions, the viewer and the tests.

import { applyEdits, audiencesOf, kindOf, splitBible, type Audience } from "@/lib/bible-sections";

export type AvatarKind = "avatar_add" | "avatar_change" | "avatar_retire";
export type ProposedAvatar = { name: string; tier: "Proven" | "Likely" | "Hypothesis"; body: string };

/** Who may edit a Bible and who decides proposals, in words for the page (roles, never names) */
export const BIBLE_EDITORS = "Execs, leads, the Head of Creative and the client's account manager";
export const BIBLE_APPROVERS = "Execs, the Head of Creative and the client's account manager";

/** A name for matching: no letter prefix ("B · "), no tier, lowercase words */
export function avatarKey(name: string) {
  return name
    .replace(/^[A-Z]\s*[·.:-]\s+/, "")
    .replace(/\((Proven|Likely|Hypothesis|Retired[^)]*)\)/gi, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The Bible's avatars, current first, each with its letter (when the Bible letters them) */
export function avatarsOf(markdown: string): (Audience & { letter: string | null; name: string })[] {
  const sec = splitBible(markdown).find((s) => kindOf(s.title) === "audiences");
  if (!sec) return [];
  return audiencesOf(sec.body).list.map((a) => {
    const m = a.title.match(/^([A-Z])\s*[·.:-]\s*(.*)$/);
    return { ...a, letter: m?.[1] ?? null, name: (m?.[2] ?? a.title).trim() };
  });
}

/** Whether a piece of text (a ticket's avatar, angle or audience) is about this avatar */
export function mentionsAvatar(avatar: string, text: string | null | undefined) {
  const k = avatarKey(avatar);
  if (!k || !text) return false;
  const t = ` ${avatarKey(text)} `;
  return t.includes(` ${k} `);
}

const headingOf = (letter: string | null, name: string, label: string) => `### ${letter ? `${letter} · ` : ""}${name.trim()} (${label})`;

/**
 * The Bible with an approved avatar change applied: an added one goes after the current ones; a changed one is written
 * fresh and the old text stays below it, labeled retired with the day; a retired one is labeled retired with the day and
 * why. Retired ones sit at the end of the section. Returns null when the avatar isn't in the Bible.
 */
export function applyAvatarChange(markdown: string, c: { kind: AvatarKind; avatar?: string | null; proposed?: ProposedAvatar | null; reason: string }, day: string): string | null {
  const sec = splitBible(markdown).find((s) => kindOf(s.title) === "audiences");
  if (!sec) {
    if (c.kind !== "avatar_add" || !c.proposed) return null;
    return applyEdits(markdown, [{ section: "Audience profiles", markdown: `${headingOf("A", c.proposed.name, c.proposed.tier)}\n${c.proposed.body.trim()}` }]).markdown;
  }
  const { intro } = audiencesOf(sec.body);
  const list = avatarsOf(markdown);
  const why = c.reason.trim().replace(/\s+/g, " ");
  type Part = { heading: string; body: string; retired: boolean };
  // The ### blocks as written (split the same way audiencesOf splits them), so the avatars that don't change keep
  // their exact words
  const raw = sec.body.split(/\n(?=###\s)/).filter((p) => p.startsWith("###"));
  const parts: Part[] = list.map((a, i) => {
    const [head, ...rest] = (raw[i] ?? "").split("\n");
    return { heading: head.trim(), body: rest.join("\n").trim(), retired: Boolean(a.retired) };
  });
  const at = c.avatar ? list.findIndex((a) => !a.retired && avatarKey(a.name) === avatarKey(c.avatar!)) : -1;
  const lettered = list.some((a) => a.letter);
  if (c.kind === "avatar_add") {
    if (!c.proposed?.name.trim()) return null;
    const used = new Set(list.map((a) => a.letter).filter(Boolean));
    const letter = lettered ? ("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").find((l) => !used.has(l)) ?? null) : null;
    parts.push({ heading: headingOf(letter, c.proposed.name, c.proposed.tier), body: `${c.proposed.body.trim()}\n\n_Added ${day} (approved proposal)${why ? `: ${why}` : ""}_`, retired: false });
  } else {
    if (at < 0) return null;
    const old = list[at];
    parts[at] = {
      heading: headingOf(old.letter, old.name, `Retired ${day}${c.kind === "avatar_change" ? ", replaced" : ""}`),
      body: `_Retired ${day}${c.kind === "avatar_change" ? `, replaced by the updated ${old.name}` : ""}${why ? `. Why: ${why}` : ""}_\n\n${old.body}`,
      retired: true,
    };
    if (c.kind === "avatar_change") {
      if (!c.proposed?.name.trim()) return null;
      parts.splice(at, 0, { heading: headingOf(old.letter, c.proposed.name, c.proposed.tier), body: `${c.proposed.body.trim()}\n\n_Updated ${day} (approved proposal)${why ? `: ${why}` : ""}_`, retired: false });
    }
  }
  // Current avatars first, the retired ones kept below them
  const ordered = [...parts.filter((p) => !p.retired), ...parts.filter((p) => p.retired)];
  const body = [intro, ...ordered.map((p) => `${p.heading}\n${p.body.trim()}`)].filter(Boolean).join("\n\n");
  return applyEdits(markdown, [{ section: sec.heading, markdown: body }]).markdown;
}

export type AvatarResults = { ads: number; spend: number; results: number; revenue: number; winners: number; losers: number; resultLabel: string; roas: boolean; target: number | null };
export type AvatarHint = { tone: "great" | "work" | "failing" | "early" | "none"; label: string; detail: string };

/**
 * A plain read of how ads made for an avatar are doing, from the client playbook's verdicts and totals: great (winners
 * and on target), needs work (mixed), isn't working (losers, or well off target with real spend), too early, or no ads yet.
 */
export function avatarHint(r: AvatarResults | null): AvatarHint {
  if (!r || !r.ads) return { tone: "none", label: "No ads yet", detail: "No ads tagged with this avatar have run yet." };
  const money = (n: number) => `$${n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2)}`;
  const cpr = r.results ? r.spend / r.results : null;
  const roas = r.spend ? r.revenue / r.spend : null;
  const perf = r.roas ? (roas != null ? `${roas.toFixed(2)}x ROAS` : "no revenue yet") : cpr != null ? `${money(cpr)} per ${r.resultLabel.replace(/s$/, "")}` : `no ${r.resultLabel} yet`;
  const detail = `${r.ads} ad${r.ads === 1 ? "" : "s"}, ${money(r.spend)} spent, ${perf}${r.target ? ` (target ${r.roas ? `${r.target}x` : money(r.target)})` : ""}${r.winners || r.losers ? `. ${r.winners} winning, ${r.losers} losing` : ""}.`;
  const onTarget = r.target ? (r.roas ? (roas ?? 0) >= r.target : cpr != null && cpr <= r.target) : null;
  const wayOff = r.target ? (r.roas ? (roas ?? 0) < r.target * 0.7 : cpr == null || cpr > r.target * 1.3) : null;
  const judged = r.winners + r.losers;
  if (r.spend < 50 && !judged) return { tone: "early", label: "Too early", detail };
  if (r.winners > 0 && r.winners >= r.losers && onTarget !== false) return { tone: "great", label: "Working", detail };
  if (r.losers > 0 && r.winners === 0 && (wayOff ?? true)) return { tone: "failing", label: "Isn't working", detail };
  if (onTarget === true) return { tone: "great", label: "Working", detail };
  if (judged || wayOff) return { tone: "work", label: "Needs work", detail };
  return { tone: "early", label: "Too early", detail };
}
