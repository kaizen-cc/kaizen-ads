// The creative's own copy on a ticket, written by the AI copywriter the moment production starts: a video's script
// (scenes, voiceover and on-screen lines, from the script writer), an image's headline and subheadline per version, a
// carousel's headline and subline per slide per version. The maker fine-tunes it in a chat; every change updates it in
// place, says what changed and can be undone. Pure: tested in tests/ticket-copy.test.ts.

import type { Script } from "./ai";

export type FrameCopy = { label: string; headline: string; subline: string };
export type SlideCopy = { headline: string; subline: string };
export type CreativeCopy =
  | { kind: "script"; script: Script }
  | { kind: "frames"; versions: FrameCopy[] }
  | { kind: "slides"; versions: { label: string; slides: SlideCopy[] }[] };

export type CopyShape = { kind: CreativeCopy["kind"]; versions: number; slides: number };

/** What the copy has to cover: one entry per version (net new and variations), and a carousel's slides */
export function copyShape(t: { format: "image" | "video" | "carousel"; newCount: number; variationCount: number; quantity?: number; cards?: number | null }): CopyShape {
  const versions = Math.max(1, Math.min(10, t.newCount + t.variationCount || t.quantity || 1));
  if (t.format === "video") return { kind: "script", versions, slides: 0 };
  if (t.format === "carousel") return { kind: "slides", versions, slides: Math.max(2, Math.min(10, t.cards ?? 5)) };
  return { kind: "frames", versions, slides: 0 };
}

const clean = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** The AI's answer, held to the shape: every version labelled V1, V2..., a carousel's slides padded or cut to the count */
export function fitCopy(raw: unknown, shape: CopyShape): CreativeCopy | null {
  if (shape.kind === "script") {
    const s = (raw as { script?: Script } | null)?.script ?? (raw as Script | null);
    return s && Array.isArray((s as Script).beats) ? { kind: "script", script: s as Script } : null;
  }
  const versions = ((raw as { versions?: unknown[] } | null)?.versions ?? []) as Record<string, unknown>[];
  if (!versions.length) return null;
  const n = Math.max(shape.versions, Math.min(versions.length, 10));
  if (shape.kind === "frames")
    return {
      kind: "frames",
      versions: Array.from({ length: n }, (_, i) => ({ label: `V${i + 1}`, headline: clean(versions[i]?.headline, 120), subline: clean(versions[i]?.subline, 200) })).filter((v, i) => i < shape.versions || v.headline),
    };
  return {
    kind: "slides",
    versions: Array.from({ length: n }, (_, i) => {
      const slides = ((versions[i]?.slides ?? []) as Record<string, unknown>[]).map((x) => ({ headline: clean(x?.headline, 120), subline: clean(x?.subline, 200) }));
      return { label: `V${i + 1}`, slides: Array.from({ length: shape.slides }, (_, j) => slides[j] ?? { headline: "", subline: "" }) };
    }).filter((v, i) => i < shape.versions || v.slides.some((x) => x.headline)),
  };
}

const q = (s: string) => (s ? `"${s}"` : "(empty)");

/** What changed between two versions of the copy, one plain line each ("V1 headline: "a" to "b""), for the chat */
export function copyDiff(a: CreativeCopy | null, b: CreativeCopy | null): string[] {
  if (!b) return [];
  if (!a || a.kind !== b.kind) return ["Wrote the copy"];
  const out: string[] = [];
  const line = (where: string, x: string, y: string) => x !== y && out.push(`${where}: ${q(x)} to ${q(y)}`);
  if (a.kind === "frames" && b.kind === "frames") {
    const n = Math.max(a.versions.length, b.versions.length);
    for (let i = 0; i < n; i++) {
      const x = a.versions[i];
      const y = b.versions[i];
      if (!y) out.push(`Removed ${x!.label}`);
      else if (!x) out.push(`Added ${y.label}: ${q(y.headline)}`);
      else {
        line(`${y.label} headline`, x.headline, y.headline);
        line(`${y.label} subheadline`, x.subline, y.subline);
      }
    }
  } else if (a.kind === "slides" && b.kind === "slides") {
    const n = Math.max(a.versions.length, b.versions.length);
    for (let i = 0; i < n; i++) {
      const x = a.versions[i];
      const y = b.versions[i];
      if (!y) out.push(`Removed ${x!.label}`);
      else if (!x) out.push(`Added ${y.label}`);
      else
        y.slides.forEach((s, j) => {
          line(`${y.label} slide ${j + 1} headline`, x.slides[j]?.headline ?? "", s.headline);
          line(`${y.label} slide ${j + 1} subline`, x.slides[j]?.subline ?? "", s.subline);
        });
    }
  } else if (a.kind === "script" && b.kind === "script") {
    const x = a.script;
    const y = b.script;
    const n = Math.max(x.beats.length, y.beats.length);
    if (x.beats.length !== y.beats.length) out.push(`${y.beats.length} scenes (was ${x.beats.length})`);
    for (let i = 0; i < n; i++) {
      const p = x.beats[i];
      const c = y.beats[i];
      if (!p || !c) continue;
      line(`Scene ${i + 1} on screen`, p.onScreen, c.onScreen);
      line(`Scene ${i + 1} voiceover`, p.voiceover, c.voiceover);
      if (p.shot !== c.shot) out.push(`Scene ${i + 1}: new shot`);
    }
    x.hooks.forEach((h, i) => y.hooks[i] && line(`Hook ${i + 1}`, h.onScreen, y.hooks[i].onScreen));
    line("CTA", x.cta, y.cta);
  }
  return out.slice(0, 30);
}

/** The copy as plain text, for the AI and for copying out */
export function copyText(c: CreativeCopy): string {
  if (c.kind === "frames") return c.versions.map((v) => `${v.label}\nHeadline: ${v.headline}\nSubheadline: ${v.subline}`).join("\n\n");
  if (c.kind === "slides") return c.versions.map((v) => `${v.label}\n${v.slides.map((s, i) => `Slide ${i + 1}: ${s.headline}${s.subline ? ` / ${s.subline}` : ""}`).join("\n")}`).join("\n\n");
  const s = c.script;
  return [
    `${s.title} (${s.lengthSeconds}s, ${s.placement})`,
    ...s.hooks.map((h, i) => `Hook ${i + 1} (${h.type}): ${h.onScreen} / "${h.spoken}"`),
    ...s.beats.map((b, i) => `Scene ${i + 1} ${b.time}: ${b.shot}\n  On screen: ${b.onScreen}\n  Voiceover: ${b.voiceover}`),
    `CTA: ${s.cta}`,
  ].join("\n");
}

/** Undo history: the earlier content, newest last, capped */
export function pushHistory(history: CreativeCopy[], prev: CreativeCopy | null, cap = 10): CreativeCopy[] {
  return prev ? [...history, prev].slice(-cap) : history;
}
