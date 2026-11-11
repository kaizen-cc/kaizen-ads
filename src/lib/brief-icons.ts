// The brief's pictograms: a small set of clean line icons, one per beat or slide, top right of its card (the lead video
// editor's brief: a person at a desk for the hook, a group for the team, a storefront and a phone for "your way").
// Plain data (paths, circles, rects on a 48 x 32 grid) so the PDF draws them with @react-pdf's Svg and the screen with
// an <svg>, the same shapes in both. iconFor picks one from the beat's name first, then what we see, with a default.
// Pure: tested in tests/brief-icons.test.ts.

export type BriefIcon = "person" | "group" | "store" | "phone" | "gauge" | "speech" | "crowd" | "box" | "ticket" | "play" | "megaphone" | "check" | "seat" | "photo";

/** ink: the line color; red: the accent; pink: the soft accent fill */
export type IconTone = "ink" | "red" | "pink";
export type IconPart =
  | { k: "path"; d: string; stroke?: IconTone; fill?: IconTone; dash?: string; w?: number }
  | { k: "circle"; cx: number; cy: number; r: number; stroke?: IconTone; fill?: IconTone; w?: number }
  | { k: "rect"; x: number; y: number; w: number; h: number; rx?: number; stroke?: IconTone; fill?: IconTone; sw?: number };

export const ICON_VIEWBOX = "0 0 48 32";
export const ICON_STROKE = 1.6;

const head = (cx: number, cy: number, r: number): IconPart => ({ k: "circle", cx, cy, r, stroke: "ink" });
const line = (d: string, stroke: IconTone = "ink", w?: number): IconPart => ({ k: "path", d, stroke, w });

export const ICONS: Record<BriefIcon, IconPart[]> = {
  // Someone on camera at a desk, recording
  person: [head(24, 9.5, 4.5), line("M14 23 C14 17.8 18.5 15.5 24 15.5 C29.5 15.5 34 17.8 34 23"), line("M8 23.5 H40"), { k: "rect", x: 12, y: 25.5, w: 24, h: 4, rx: 1.5, fill: "red" }, { k: "circle", cx: 39.5, cy: 5.5, r: 2, fill: "ink" }],
  // Three people
  group: [
    head(24, 9, 4),
    line("M16 24 C16 18.5 19.5 15.5 24 15.5 C28.5 15.5 32 18.5 32 24"),
    head(12.5, 12.5, 3.3),
    line("M5.5 26 C5.5 21.5 8.5 19 12.5 19 C14.5 19 16 19.6 17.2 20.4"),
    head(35.5, 12.5, 3.3),
    line("M42.5 26 C42.5 21.5 39.5 19 35.5 19 C33.5 19 32 19.6 30.8 20.4"),
  ],
  // A storefront and a phone: in person or online
  store: [
    { k: "path", d: "M4 11 L7.5 4 H28.5 L32 11 Z", stroke: "ink", fill: "pink" },
    line("M6 11 V28 H30 V11"),
    { k: "rect", x: 14, y: 18, w: 8, h: 10, stroke: "ink" },
    { k: "rect", x: 36, y: 5, w: 9, h: 23, rx: 2, stroke: "ink" },
    line("M39 24.5 H42"),
  ],
  // A phone: the end card, the call to action
  phone: [{ k: "rect", x: 17, y: 2, w: 14, h: 28, rx: 3, stroke: "ink" }, { k: "circle", cx: 24, cy: 10, r: 2.4, fill: "ink" }, line("M20.5 19 H27.5", "red", 2), line("M20.5 23.5 H27.5")],
  // A signal reading: start to finish, how fast, the process
  gauge: [
    line("M7 23 A17 17 0 0 1 41 23", "ink", 1.2),
    line("M12.5 23 A11.5 11.5 0 0 1 35.5 23", "ink", 1.2),
    line("M18 23 A6 6 0 0 1 30 23", "ink", 1.2),
    line("M10 7 L24 23", "red", 1.8),
    { k: "circle", cx: 24, cy: 23, r: 1.9, fill: "red" },
    line("M5 28.5 H43"),
  ],
  // Someone and what they say
  speech: [
    head(13, 15.5, 3.8),
    line("M5 30 C5 25 8.5 22.5 13 22.5 C17.5 22.5 21 25 21 30"),
    { k: "path", d: "M24 2.5 H43 A2 2 0 0 1 45 4.5 V14.5 A2 2 0 0 1 43 16.5 H30 L25.5 20.5 V16.5 H24 A2 2 0 0 1 22 14.5 V4.5 A2 2 0 0 1 24 2.5 Z", stroke: "ink" },
    line("M26 7.5 H41"),
    line("M26 11.5 H36", "red"),
  ],
  // A crowd at a show
  crowd: [
    head(10, 12, 3),
    head(24, 10, 3.4),
    head(38, 12, 3),
    head(17, 17, 2.8),
    head(31, 17, 2.8),
    line("M4 28 C4 24 6.5 21.5 10 21.5 C11.6 21.5 12.8 22 13.8 22.8"),
    line("M44 28 C44 24 41.5 21.5 38 21.5 C36.4 21.5 35.2 22 34.2 22.8"),
    line("M11 29 C11 25.5 13.5 23.5 17 23.5 C20.5 23.5 23 25.5 23 29"),
    line("M25 29 C25 25.5 27.5 23.5 31 23.5 C34.5 23.5 37 25.5 37 29"),
    line("M21 3 L24 5.5 L27 3", "red"),
  ],
  // A product box
  box: [{ k: "path", d: "M24 3.5 L40 10.5 V24 L24 30 L8 24 V10.5 Z", stroke: "ink" }, line("M8 10.5 L24 17.5 L40 10.5"), line("M24 17.5 V30"), line("M16 7 L32 14", "red", 2)],
  // A ticket, a seat
  ticket: [
    { k: "path", d: "M5 7 H43 V13 A3 3 0 0 0 43 19 V25 H5 V19 A3 3 0 0 0 5 13 Z", stroke: "ink" },
    { k: "path", d: "M33 8 V24", stroke: "ink", dash: "2 2" },
    line("M10 13 H27", "red", 2),
    line("M10 18.5 H22"),
  ],
  // A video, B-roll
  play: [{ k: "rect", x: 6, y: 4, w: 36, h: 24, rx: 4, stroke: "ink" }, { k: "path", d: "M21 10.5 L30.5 16 L21 21.5 Z", fill: "red" }],
  // An offer, news
  megaphone: [{ k: "path", d: "M9 12 H15 L33 5 V27 L15 20 H9 Z", stroke: "ink" }, line("M13 20 L15 28 H19 L17.5 21"), line("M37 11.5 A6 6 0 0 1 37 20.5", "red"), line("M40.5 8 A11 11 0 0 1 40.5 24")],
  // The payoff, done
  check: [{ k: "circle", cx: 24, cy: 16, r: 12.5, stroke: "ink" }, line("M18 16.5 L22.5 21 L31 11.5", "red", 2.2)],
  // A stadium seat, side on: the seat view, the section
  seat: [
    { k: "path", d: "M15 4.5 H22 A2 2 0 0 1 24 6.5 V18 H15 A2 2 0 0 1 13 16 V6.5 A2 2 0 0 1 15 4.5 Z", stroke: "ink", fill: "pink" },
    line("M11 18.5 H33 A2 2 0 0 1 35 20.5 V21.5 H11 Z"),
    line("M15 21.5 L13 29"),
    line("M31 21.5 L33 29"),
    line("M28 18.5 V14.5 H35", "red", 1.8),
    line("M5 29.5 H43"),
  ],
  // A photo: the picture in the frame
  photo: [
    { k: "rect", x: 7, y: 4, w: 34, h: 24, rx: 3, stroke: "ink" },
    line("M7 24 L17 15 L24 21.5 L29 17 L41 26.5"),
    { k: "circle", cx: 32.5, cy: 11, r: 2.8, fill: "red" },
  ],
};

// Read from the name first, then what we see: the first rule that matches wins, so order goes from most to least specific
const RULES: [RegExp, BriefIcon][] = [
  [/\b(end ?card|outro|sign[- ]?off|cta|call to action|link in bio|tap|app|swipe up)\b/i, "phone"],
  [/\b(hook|opener|opening|intro|cold open|talking head|selfie|on camera)\b/i, "person"],
  [/\b(team|staff|crew|experts?|employees|family|founders?|people)\b/i, "group"],
  [/\b(stores?|shop|storefront|locations?|in person|online|website|your way|ways? to buy)\b/i, "store"],
  [/\b(start to finish|beginning to the end|journey|process|steps?|how it works|fast|speed|signal|end to end)\b/i, "gauge"],
  [/\b(difference|why|testimonials?|reviews?|quotes?|says|story|promise|answer|interview|proof)\b/i, "speech"],
  [/\b(crowd|fans|audience|arena|stadium|concerts?|game|events?|venue)\b/i, "crowd"],
  [/\b(seats?|tickets?|section|views?|row)\b/i, "ticket"],
  [/\b(products?|box|package|unbox(ing)?|delivery|orders?|bottles?|kit)\b/i, "box"],
  [/\b(offers?|sale|deals?|promo|launch|news|announce\w*|discount)\b/i, "megaphone"],
  [/\b(payoff|results?|benefits?|done|finish|before and after|guarantee)\b/i, "check"],
  [/\b(demo|videos?|clips?|reels?|b-?roll|footage|montage)\b/i, "play"],
];

const match = (s: string) => {
  const t = s.trim();
  if (!t) return null;
  for (const [re, icon] of RULES) if (re.test(t)) return icon;
  return null;
};

/** The pictogram for a beat or slide: by its name, else by what we see, else the default */
export function iconFor(name: string, description = "", fallback: BriefIcon = "play"): BriefIcon {
  return match(name) ?? match(description) ?? fallback;
}

// A single image shows a thing, not a moment: the seat, the product, the place, the photo (a group only when people
// are what's in the picture, never because a headline says "most people")
const IMAGE_RULES: [RegExp, BriefIcon][] = [
  [/\b(seats?|section|rows?|arena|stadium|bleachers?|seat[- ]views?)\b/i, "seat"],
  [/\b(products?|box|package|packaging|bottles?|kit|jars?|cans?|bags?|unbox(ing)?)\b/i, "box"],
  [/\b(stores?|shop|storefront|patio|restaurant|location|dining room|bar)\b/i, "store"],
  [/\b(tickets?|passes?|admission)\b/i, "ticket"],
  [/\b(offers?|sale|deals?|promo|discount|% off)\b/i, "megaphone"],
  [/\b(photos?|pictures?|stills?|shots?|images?|snaps?|views?)\b/i, "photo"],
  [/\b(app|website|screen|checkout)\b/i, "phone"],
  [/\b(team|staff|crew|family|founders?|customers? (?:in|at|on)|people (?:in|at|on))\b/i, "group"],
];

/** The pictogram for a single image's version: by what's in the frame, else its headline, else a photo */
export function iconForImage(shows: string, headline = "", fallback: BriefIcon = "photo"): BriefIcon {
  for (const t of [shows, headline]) {
    if (!t.trim()) continue;
    for (const [re, icon] of IMAGE_RULES) if (re.test(t)) return icon;
  }
  return fallback;
}
