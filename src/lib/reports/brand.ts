// A report's co-branding, as plain functions (no server code), shared by the PDF, the client page and the tests: the
// client's brand colour turned into a palette that always reads (an accent dark enough for bars and labels on white, a
// deep shade for the header band that white text sits on, soft tints for tile accents), picked from the Brand Bible's
// colours when it names them, else from the logo's own pixels. Nothing here invents a colour: no brand colour found
// means the report's own calm navy (Kaizen's look), or a quiet slate for a white label client.

export type Rgb = [number, number, number];

/** "#1A2b3c", "1a2b3c" or "#abc" → [r, g, b]; null when it isn't a colour */
export function parseHex(hex: string | null | undefined): Rgb | null {
  const m = String(hex ?? "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(m)) return [0, 1, 2].map((i) => parseInt(m[i] + m[i], 16)) as Rgb;
  if (/^[0-9a-f]{6}$/i.test(m)) return [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16)) as Rgb;
  return null;
}

export const toHex = ([r, g, b]: Rgb) => `#${[r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("")}`;

/** WCAG relative luminance (0 black, 1 white) */
export function luminance([r, g, b]: Rgb) {
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

/** WCAG contrast ratio between two colours (1 to 21) */
export function contrast(a: string | Rgb, b: string | Rgb) {
  const x = typeof a === "string" ? parseHex(a) : a;
  const y = typeof b === "string" ? parseHex(b) : b;
  if (!x || !y) return 1;
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/** Saturation (HSL, 0 to 1): how much colour there is, so greys and near blacks aren't taken for a brand colour */
export function saturation([r, g, b]: Rgb) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  if (max === min) return 0;
  return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
}

/** Hue in degrees (0 to 360) */
export function hue([r, g, b]: Rgb) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  if (max === min) return 0;
  const d = max - min;
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return (h * 60 + 360) % 360;
}

/** A colour from hue (degrees), saturation and lightness (0 to 1) */
export function fromHsl(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** a mixed toward b by t (0: a, 1: b) */
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as Rgb;

const WHITE: Rgb = [255, 255, 255];
const NIGHT: Rgb = [9, 17, 30];

/** The colour mixed toward black (or the deep night tone) until it has at least `ratio` contrast with white */
export function darkenTo(c: Rgb, ratio: number, toward: Rgb = [0, 0, 0]): Rgb {
  if (contrast(c, WHITE) >= ratio) return c;
  for (let t = 0.04; t <= 1; t += 0.04) {
    const d = mix(c, toward, t);
    if (contrast(d, WHITE) >= ratio) return d;
  }
  return toward;
}

/** A colour worth calling the brand's: some colour in it, neither near white nor near black */
export const brandWorthy = (c: Rgb) => saturation(c) >= 0.22 && luminance(c) > 0.004 && luminance(c) < 0.8;

/** The brand colour among candidates (the Brand Bible's, or the logo's): the first with real colour in it */
export function pickBrandColor(candidates: (string | null | undefined)[]): string | null {
  for (const h of candidates) {
    const c = parseHex(h);
    if (c && brandWorthy(c)) return toHex(c);
  }
  return null;
}

/**
 * The colours a Brand Bible names (hex codes), those on a line about colour first ("Colors: navy #102D45, sand #E8DCC4"),
 * else every hex code in it. Order kept: the primary colour is usually named first.
 */
export function colorsFromBible(markdown: string | null | undefined): string[] {
  const text = String(markdown ?? "");
  const hexes = (s: string) => [...s.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)].map((m) => toHex(parseHex(m[1])!));
  const lines = text.split(/\r?\n/).filter((l) => /colou?r|palette|primary|accent|brand hex/i.test(l));
  const named = lines.flatMap(hexes);
  return [...new Set(named.length ? named : hexes(text))];
}

/**
 * The brand colour in a logo's pixels: its opaque pixels bucketed, the commonest bucket with real colour in it (a
 * black or grey wordmark has none: null). pixels: RGBA bytes.
 */
export function colorFromPixels(pixels: Uint8Array | number[], channels = 4): string | null {
  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + channels - 1 < pixels.length; i += channels) {
    if (channels === 4 && pixels[i + 3] < 200) continue;
    const c: Rgb = [pixels[i], pixels[i + 1], pixels[i + 2]];
    if (!brandWorthy(c)) continue;
    const key = c.map((v) => v >> 5).join(",");
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += c[0];
    e.g += c[1];
    e.b += c[2];
    buckets.set(key, e);
  }
  const top = [...buckets.values()].sort((a, b) => b.n - a.n)[0];
  const opaque = channels === 4 ? Math.max(1, Array.from({ length: Math.floor(pixels.length / 4) }, (_, i) => pixels[i * 4 + 3]).filter((a) => a >= 200).length) : pixels.length / channels;
  // A speck of colour in a big black wordmark isn't the brand's colour
  if (!top || top.n < opaque * 0.04) return null;
  return toHex([top.r / top.n, top.g / top.n, top.b / top.n]);
}

/** Whether a logo is light (a white wordmark meant for dark backgrounds): it then sits on a dark chip */
export function isLightLogo(pixels: Uint8Array | number[], channels = 4) {
  let n = 0;
  let sum = 0;
  for (let i = 0; i + channels - 1 < pixels.length; i += channels) {
    if (channels === 4 && pixels[i + 3] < 200) continue;
    n++;
    sum += luminance([pixels[i], pixels[i + 1], pixels[i + 2]]);
  }
  return n > 0 && sum / n > 0.72;
}

/**
 * The report's palette.
 * accent: bars, rules and small labels on white (3:1 against white at least, as WCAG asks of graphics).
 * accentText: the accent where it's text on white (4.5:1).
 * hero: the header band, with white text on it (10:1 or more).
 * heroSoft: the eyebrow on the band (light, still 4.5:1 on it).
 * soft: a pale tint for tile accents and the bar track.
 * line: the second series in the chart (the cost line), a hue away from the accent so the two never blur together.
 */
export type Palette = { accent: string; accentText: string; hero: string; heroEdge: string; heroSoft: string; soft: string; line: string; brand: string | null };

/** The report's own look when the client has no brand colour: the navy and ocean blue of the reference report */
export const DEFAULT_BRAND = "#2785bb";
const SLATE = "#475569";

export function paletteFor(brand: string | null | undefined, opts: { whiteLabel?: boolean } = {}): Palette {
  const picked = pickBrandColor([brand]);
  const base = parseHex(picked ?? (opts.whiteLabel ? SLATE : DEFAULT_BRAND))!;
  // A very dark brand (a navy, an aubergine) is the band itself; its accent is the same hue at a mid tone with its colour
  // kept (lightening toward white alone turns a navy grey)
  const deep = contrast(base, WHITE) > 9;
  const accent = deep ? darkenTo(fromHsl(hue(base), Math.max(saturation(base), 0.55), 0.44), 3) : darkenTo(base, 3);
  const accentText = darkenTo(accent, 4.6);
  const hero = deep && contrast(base, WHITE) >= 12 ? base : darkenTo(mix(base, NIGHT, 0.55), 12, NIGHT);
  const heroEdge = mix(hero, deep ? accent : base, 0.3);
  // The eyebrow on the band: the brand lightened until it reads on the band
  let heroSoft = mix(base, WHITE, 0.45);
  for (let t = 0.45; t <= 1 && contrast(heroSoft, hero) < 4.5; t += 0.05) heroSoft = mix(base, WHITE, t);
  const soft = mix(accent, WHITE, 0.9);
  // The cost line: warm against a cool brand, deep blue against a warm one
  const h = hue(base);
  const warm = h < 70 || h > 300;
  const line = warm ? "#1f4e79" : "#d9663f";
  return { accent: toHex(accent), accentText: toHex(accentText), hero: toHex(hero), heroEdge: toHex(heroEdge), heroSoft: toHex(heroSoft), soft: toHex(soft), line, brand: picked };
}
