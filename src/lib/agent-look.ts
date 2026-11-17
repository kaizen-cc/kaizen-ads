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

/** A person's assistant color: their pick when it's one of the palette's, else the default */
export const assistantTintOf = (picked: unknown) => paletteColor(picked) ?? ASSISTANT_TINT;
