// Quiet tints so clients and people are easy to tell apart at a glance. Same name → same color, everywhere.
const TINTS = ["#d64550", "#9b6fd1", "#3f8fbf", "#4fa877", "#c98a3c", "#7a7fd6", "#c4568f", "#3fa9a0", "#b8a03a"];

export function tintFor(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length];
}
