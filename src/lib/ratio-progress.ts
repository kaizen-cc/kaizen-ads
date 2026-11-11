// The sizes a ticket needs against what's uploaded, version by version ("V1 4:5 ✓ 9:16 missing"), from the same
// rules as the size checks before the AI review (src/lib/creative-complete.ts): 4:5 and 9:16 per design, every card
// of a carousel. Versions not uploaded yet show as rows with nothing in. Pure: tested in tests/ratio-progress.test.ts.

export type RatioTicket = { format: "image" | "video" | "carousel"; sizes: string[]; newCount: number; variationCount: number; cards?: number | null };
export type RatioDesign = { position: number; isVariation: boolean; files: { aspect: string | null; card: number | null }[] };

export type RatioItem = { label: string; ok: boolean };
export type RatioRow = { label: string; uploaded: boolean; variation: boolean; items: RatioItem[] };
export type RatioProgress = { rows: RatioRow[]; done: number; total: number };

const STANDARD = ["4x5", "9x16"];
const label = (s: string) => s.replace("x", ":");

/** The sizes each design must have: the ticket's own among the standard ones, or both standard ones when none is set */
export function neededSizes(sizes: string[]) {
  const asked = sizes.map((s) => s.replace(":", "x")).filter((s) => STANDARD.includes(s));
  return asked.length ? [...new Set(asked)] : STANDARD;
}

export function ratioProgress(t: RatioTicket, designs: RatioDesign[]): RatioProgress {
  const sizes = neededSizes(t.sizes);
  const wantCards = Math.max(2, t.cards ?? 5);
  const itemsFor = (d: RatioDesign | null): RatioItem[] => {
    if (t.format === "carousel") {
      const have = d ? new Set(d.files.map((f) => f.card).filter((c): c is number => c != null)).size || d.files.length : 0;
      return [{ label: `${Math.min(have, wantCards)} of ${wantCards} slides`, ok: have >= wantCards }];
    }
    const got = new Set((d?.files ?? []).map((f) => f.aspect).filter(Boolean) as string[]);
    return sizes.map((s) => ({ label: label(s), ok: got.has(s) }));
  };
  const ordered = [...designs].sort((a, b) => a.position - b.position);
  const rows: RatioRow[] = ordered.map((d) => ({ label: `V${d.position}`, uploaded: d.files.length > 0, variation: d.isVariation, items: itemsFor(d) }));
  // What's asked for but not started: net new first, then variations
  const net = designs.filter((d) => !d.isVariation).length;
  const vars = designs.length - net;
  let next = (ordered.at(-1)?.position ?? 0) + 1;
  for (let i = net; i < t.newCount; i++) rows.push({ label: `V${next++}`, uploaded: false, variation: false, items: itemsFor(null) });
  for (let i = vars; i < t.variationCount; i++) rows.push({ label: `V${next++}`, uploaded: false, variation: true, items: itemsFor(null) });
  const all = rows.flatMap((r) => r.items);
  return { rows, done: all.filter((i) => i.ok).length, total: all.length };
}
