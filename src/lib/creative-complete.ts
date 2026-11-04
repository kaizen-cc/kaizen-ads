// What a ticket still needs before its creative is all in: the net new and variation counts, every size asked for on
// each design (4:5 and 9:16; a 1:1 isn't part of the standard any more) and every card of a carousel. Shared by the
// ticket (the advisory under the uploads) and the server (the AI review starts on its own once nothing is missing).

export type CompleteTicket = { format: "image" | "video" | "carousel"; sizes: string[]; newCount: number; variationCount: number; cards?: number | null };
export type CompleteDesign = { position: number; isVariation: boolean; files: { aspect: string | null; card: number | null }[] };

const STANDARD = new Set(["4x5", "9x16"]);
const label = (s: string) => s.replace("x", ":");
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function creativeMissing(t: CompleteTicket, designs: CompleteDesign[]): string[] {
  const out: string[] = [];
  const net = designs.filter((d) => !d.isVariation).length;
  const vars = designs.length - net;
  if (net < t.newCount) out.push(`${plural(t.newCount - net, "more net new design")}`);
  if (vars < t.variationCount) out.push(`${plural(t.variationCount - vars, "more variation")}`);
  for (const d of designs) {
    if (!d.files.length) {
      out.push(`D${d.position}: its files didn't finish uploading`);
      continue;
    }
    if (t.format === "carousel") {
      const want = Math.max(2, t.cards ?? 5);
      const have = new Set(d.files.map((f) => f.card).filter((c): c is number => c != null)).size || d.files.length;
      if (have < want) out.push(`D${d.position}: ${have} of ${want} cards`);
      continue;
    }
    const sizes = new Set(d.files.map((f) => f.aspect).filter(Boolean) as string[]);
    const lacking = t.sizes.filter((s) => STANDARD.has(s) && !sizes.has(s));
    if (lacking.length) out.push(`Missing ${lacking.map(label).join(" and ")} for D${d.position}`);
  }
  return out;
}
