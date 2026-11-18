// Search that forgives how a name is typed: accents, case and punctuation don't matter ("cafe" finds "Café Diario",
// "jjs" finds "J.J.'s", "oceanbox" finds "Ocean Box"). Pure, shared by every list that filters as you type.

/** A name as search compares it: no accents, lower case, punctuation gone, single spaces */
export function foldText(s: string | null | undefined): string {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/æ/gi, "ae")
    .replace(/ø/gi, "o")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Whether what was typed is found in the text: folded, and also with the spaces taken out on both sides */
export function foldMatch(text: string | null | undefined, typed: string | null | undefined): boolean {
  const q = foldText(typed);
  if (!q) return true;
  const t = foldText(text);
  if (t.includes(q)) return true;
  return t.replace(/ /g, "").includes(q.replace(/ /g, ""));
}
