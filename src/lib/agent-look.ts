// Each agent's color (by its icon), shared by the agents page and the Expenses breakdown so an agent looks the same
// everywhere.
export const AGENT_TINT: Record<string, string> = { compass: "#5b8def", shield: "#b21e2c", feed: "#2fa37a", pen: "#c08a2e", rocket: "#8a63d2", pulse: "#d1495b", film: "#e07a3f", book: "#3fa7b5", eye: "#6c7ee1", scan: "#9b6bd6", target: "#e0a03f", spark: "#888888" };
export const tintOf = (icon: string | null | undefined) => AGENT_TINT[icon ?? ""] ?? AGENT_TINT.spark;

/** The personal assistant's colour (Call my assistant), the same on the menu, the call and its page */
export const ASSISTANT_TINT = "#b06ad9";

/**
 * The colors a person can give their own assistant (the Assistant page): mid-tone, so each reads on the light and the
 * dark theme, as text, as a soft fill (with alpha) and as a glow. The first is the default.
 */
export const ASSISTANT_PALETTE: { hex: string; name: string }[] = [
  { hex: ASSISTANT_TINT, name: "Orchid" },
  { hex: "#6c7ee1", name: "Periwinkle" },
  { hex: "#3b8fd4", name: "Ocean" },
  { hex: "#2a9d8f", name: "Teal" },
  { hex: "#2fa37a", name: "Jade" },
  { hex: "#7f9c3a", name: "Moss" },
  { hex: "#d39b2a", name: "Amber" },
  { hex: "#e0704f", name: "Coral" },
  { hex: "#d4507a", name: "Rose" },
  { hex: "#7b8494", name: "Slate" },
];

/** A color from the palette (any case), or null when it isn't one */
export function paletteColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const hex = v.trim().toLowerCase();
  return ASSISTANT_PALETTE.some((c) => c.hex === hex) ? hex : null;
}

/** A typed or picked hex ("#2A9D8F", "2a9d8f", "#2a9") as a lowercase #rrggbb, or null when it isn't one */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().toLowerCase().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${h}`;
}

/**
 * Any color reads on both themes once its lightness is held to the middle (a near-white or near-black pick would vanish
 * on one of them): the hue and most of the saturation stay, only the lightness is brought into 40 to 62 percent.
 */
export function fitTone(hex: string): string {
  const n = normalizeHex(hex);
  if (!n) return ASSISTANT_TINT;
  const r = parseInt(n.slice(1, 3), 16) / 255;
  const g = parseInt(n.slice(3, 5), 16) / 255;
  const b = parseInt(n.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const L = Math.min(0.62, Math.max(0.4, l));
  if (L === l) return n;
  const c = (1 - Math.abs(2 * L - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = L - c / 2;
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hx = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${hx(r1)}${hx(g1)}${hx(b1)}`;
}

/** A color a person may give their assistant: a swatch as it is, any other valid hex fitted to read on both themes */
export function pickedColor(v: unknown): string | null {
  const swatch = paletteColor(v);
  if (swatch) return swatch;
  const hex = normalizeHex(v);
  return hex ? fitTone(hex) : null;
}

/** A person's assistant color: their pick (a swatch or their own hex), else the default */
export const assistantTintOf = (picked: unknown) => pickedColor(picked) ?? ASSISTANT_TINT;

/** What a person calls their assistant: a short plain name (letters, numbers, spaces, . ' -), or null for the default */
export function cleanAssistantName(v: unknown): string | null {
  const s = String(v ?? "")
    .replace(/[^\p{L}\p{N} .'’-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24)
    .trim();
  return s || null;
}

/** What a call or chat's heading says for the assistant: the name they gave it, else "Your assistant" */
export const assistantTitle = (label: string | null | undefined) => (label && label !== "Assistant" ? label : "Your assistant");

/** A color said or typed to the assistant: a swatch's name ("teal"), or any hex; the result is what gets saved (or null) */
export function colorFromWords(v: unknown): string | null {
  const word = String(v ?? "").trim().toLowerCase();
  const swatch = ASSISTANT_PALETTE.find((c) => c.name.toLowerCase() === word);
  return swatch ? swatch.hex : pickedColor(word);
}
