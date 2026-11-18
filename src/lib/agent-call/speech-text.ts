// Text as the call's voice should say it. The low-latency voices read raw digits, symbols and short forms oddly
// ("$1.2k", "3-5", "CTR", "11/3"), so a sentence is put into plain spoken words before it goes to the voice: money,
// percentages, decimals, ranges, dates, times, "vs", "&" and "/", and the ad world's short forms said as letters.
// Links and email addresses are never read out. Markdown and emojis are already gone (speakable() runs first, and
// marks where a bare link was).
// Names are left as written, except the brand names the voice gets wrong, which are respelled the way they're said
// (SAY_AS below: data, so a brand is added in one line). Pure: no keys, no calls.

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: [number, string][] = [
  [1e12, "trillion"],
  [1e9, "billion"],
  [1e6, "million"],
  [1e3, "thousand"],
];

function under1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} hundred`);
    n %= 100;
  }
  if (n >= 20) {
    parts.push(n % 10 ? `${TENS[Math.floor(n / 10)]} ${ONES[n % 10]}` : TENS[Math.floor(n / 10)]);
  } else if (n > 0 || !parts.length) parts.push(ONES[n]);
  return parts.join(" ");
}

/** A whole number in words ("thirty thousand five hundred twelve") */
export function intWords(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `minus ${intWords(-n)}`;
  n = Math.floor(n);
  if (n < 1000) return under1000(n);
  const parts: string[] = [];
  for (const [size, name] of SCALES) {
    if (n >= size) {
      parts.push(`${intWords(Math.floor(n / size))} ${name}`);
      n %= size;
    }
  }
  if (n > 0) parts.push(under1000(n));
  return parts.join(" ");
}

/** A number as written ("1.25", "30,512") in words: digits after the point are said one by one ("one point two five") */
export function numberWords(raw: string): string {
  const s = raw.replace(/,/g, "");
  const [whole, frac] = s.split(".");
  const w = intWords(Number(whole || "0"));
  if (!frac) return w;
  return `${w} point ${frac
    .split("")
    .map((d) => ONES[Number(d)])
    .join(" ")}`;
}

const ORDINAL_SPECIAL: Record<string, string> = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };

/** 3 → "third", 21 → "twenty first" */
export function ordinalWords(n: number): string {
  const w = intWords(n).split(" ");
  const last = w.pop() ?? "";
  const ord = ORDINAL_SPECIAL[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return [...w, ord].join(" ");
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_SHORT: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

/** A year as people say it (2026 → "twenty twenty six", 2005 → "two thousand five") */
function yearWords(y: number): string {
  if (y >= 2000 && y < 2010) return intWords(y);
  if (y >= 1900 && y < 2100) {
    const hi = Math.floor(y / 100);
    const lo = y % 100;
    return `${intWords(hi)} ${lo === 0 ? "hundred" : lo < 10 ? `oh ${intWords(lo)}` : intWords(lo)}`;
  }
  return intWords(y);
}

/** Money: "$1.2k" → "one point two thousand dollars", "$12.50" → "twelve dollars and fifty cents" */
function moneyWords(amount: string, suffix: string | undefined): string {
  const scale = (suffix ?? "").toLowerCase();
  const scaleWord = scale === "k" || scale === "thousand" ? " thousand" : scale === "m" || scale === "mm" || scale === "million" ? " million" : scale === "b" || scale === "bn" || scale === "billion" ? " billion" : "";
  const clean = amount.replace(/,/g, "");
  if (!scaleWord && /^\d+\.\d{2}$/.test(clean)) {
    const [d, c] = clean.split(".");
    const cents = Number(c);
    const dollars = Number(d);
    if (cents === 0) return `${intWords(dollars)} ${dollars === 1 ? "dollar" : "dollars"}`;
    if (dollars === 0) return `${intWords(cents)} ${cents === 1 ? "cent" : "cents"}`;
    return `${intWords(dollars)} ${dollars === 1 ? "dollar" : "dollars"} and ${intWords(cents)} ${cents === 1 ? "cent" : "cents"}`;
  }
  const n = numberWords(clean);
  return `${n}${scaleWord} ${n === "one" && !scaleWord ? "dollar" : "dollars"}`;
}

/** Times: "3:30pm" → "three thirty p m", "10:05" → "ten oh five", "9am" → "nine a m" */
function timeWords(h: string, m: string | undefined, ap: string | undefined): string {
  const hour = intWords(Number(h));
  const min = m === undefined || m === "00" ? (ap ? "" : " o'clock") : Number(m) < 10 ? ` oh ${intWords(Number(m))}` : ` ${intWords(Number(m))}`;
  const half = ap ? ` ${ap.toLowerCase().replace(/\./g, "").split("").join(" ")}` : "";
  return `${hour}${min}${half}`;
}

/** Short forms said letter by letter (and their plurals: "KPIs" → "K P Is") */
const LETTERS = ["ROAS", "CTR", "CPM", "CPA", "KPI", "SMS", "CPC", "AOV", "ID", "URL", "AI", "OS", "CVR", "CPL", "ROI", "UGC", "LTV", "SKU", "QA", "PDF", "CRM", "SEO", "B2B", "B2C", "DM", "CTA", "IS"];
const LETTER_RE = new RegExp(`\\b(${LETTERS.join("|")})(s)?\\b`, "g");

/**
 * Brand names the voice says wrong, respelled the way they're said (the captions keep the real spelling; only what the
 * voice reads changes). Matched as whole words, any case, with a possessive kept ("Klaviyo's"). ElevenLabs'
 * pronunciation dictionaries would do the same through an uploaded rules file attached to every request; a respelling
 * works on every voice and model with nothing to keep in sync. Add a brand here when the voice gets it wrong.
 */
export const SAY_AS: Record<string, string> = {
  Klaviyo: "Clay-vee-oh",
  Cloudbeds: "Cloud beds",
  "Customer.io": "Customer I O",
  Gorgias: "Gor-gee-us",
  SevenRooms: "Seven Rooms",
  OpenTable: "Open Table",
  WooCommerce: "Woo Commerce",
  BigCommerce: "Big Commerce",
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SAY_AS_RE = new RegExp(`(?<![\\w.])(${Object.keys(SAY_AS).map(escapeRe).join("|")})(?!\\w|\\.\\w)`, "gi");
const SAY_AS_KEY = new Map(Object.keys(SAY_AS).map((k) => [k.toLowerCase(), k]));

/** Brand names respelled for the voice ("Klaviyo's flows" → "Clay-vee-oh's flows") */
export function sayAs(text: string): string {
  return text.replace(SAY_AS_RE, (m: string) => SAY_AS[SAY_AS_KEY.get(m.toLowerCase()) ?? m] ?? m);
}

/** Links and email addresses: never read out */
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|io|co|net|org|ai|app|dev)(?:\/\S*)?\b/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
export const LINK_LINE = "I've put the link on screen.";

/**
 * One sentence for the voice, in spoken words. Order matters: links and emails out first, then money (before plain
 * numbers), ranges, percentages, dates and times, then any number left, then symbols and short forms.
 */
export function forSpeech(input: string): string {
  // Brand names first: "Customer.io" is a name, not a link
  let t = ` ${sayAs(input)} `;
  let linked = false;
  t = t.replace(EMAIL_RE, () => {
    linked = true;
    return " ";
  });
  t = t.replace(URL_RE, () => {
    linked = true;
    return " ";
  });
  // Where speakable() took a bare link out (with a little lead-in like "at" or "here:")
  t = t.replace(/(?:\b(?:at|on|via|here)\s*:?\s*)?\uE000/gi, () => {
    linked = true;
    return " ";
  });

  // Money ranges first ("$10-$20", "$10-20k"), then money
  t = t.replace(/\$(\d[\d,]*(?:\.\d+)?)(?:\s*(k|mm|m|bn|b)\b)?\s*(?:-|–|to)\s*\$?(\d[\d,]*(?:\.\d+)?)(?:\s*(k|mm|m|bn|b|thousand|million|billion)\b)?/gi, (_, a, sa, b, sb) => `${moneyWords(a, sa ?? sb).replace(/ dollars?$/, "")} to ${moneyWords(b, sb)}`);
  t = t.replace(/\$(\d[\d,]*(?:\.\d+)?)(?:\s*(k|mm|m|bn|b|thousand|million|billion)\b)?/gi, (_, a, s) => moneyWords(a, s));
  t = t.replace(/(\d[\d,]*(?:\.\d+)?)\s*(?:USD|dollars)\b/g, (_, a) => moneyWords(a, undefined));

  // Percentages (and ranges of them)
  t = t.replace(/(\d[\d,]*(?:\.\d+)?)\s*(?:-|–|to)\s*(\d[\d,]*(?:\.\d+)?)\s*%/g, (_, a, b) => `${numberWords(a)} to ${numberWords(b)} percent`);
  t = t.replace(/([+-])?(\d[\d,]*(?:\.\d+)?)\s*%/g, (_, sign, a) => `${sign === "+" ? "up " : sign === "-" ? "down " : ""}${numberWords(a)} percent`);

  // Dates: 2026-11-03, Nov 3(rd), November 3, 11/3(/2026)
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) => (Number(mo) >= 1 && Number(mo) <= 12 ? `${MONTHS[Number(mo) - 1]} ${ordinalWords(Number(d))}, ${yearWords(Number(y))}` : m));
  t = t.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/g, (_, mo: string, d, y) => `${MONTHS[MONTH_SHORT[mo.toLowerCase()]]} ${ordinalWords(Number(d))}${y ? `, ${yearWords(Number(y))}` : ""}`);
  t = t.replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, (m, mo, d, y) => {
    if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return m;
    const year = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : null;
    return `${MONTHS[Number(mo) - 1]} ${ordinalWords(Number(d))}${year ? `, ${yearWords(year)}` : ""}`;
  });
  t = t.replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/g, (_, d) => ordinalWords(Number(d)));

  // Times: 3:30pm, 3pm, 10:05, 9 a.m.
  t = t.replace(/\b(\d{1,2}):(\d{2})\s*([ap](?:\.m\.|m))?(?=\W)/gi, (_, h, m, ap) => timeWords(h, m, ap));
  t = t.replace(/\b(\d{1,2})\s*([ap](?:\.m\.|m))(?=\W)/gi, (_, h, ap) => timeWords(h, undefined, ap));

  // Ranges of plain numbers: "3-5 days" → "three to five days"
  t = t.replace(/\b(\d[\d,]*(?:\.\d+)?)\s*(?:-|–)\s*(\d[\d,]*(?:\.\d+)?)\b/g, (_, a, b) => `${numberWords(a)} to ${numberWords(b)}`);
  // Multipliers: "2.4x" → "two point four x"
  t = t.replace(/\b(\d[\d,]*(?:\.\d+)?)x\b/g, (_, a) => `${numberWords(a)} x`);
  // Shorthand thousands and millions: "12k impressions"
  t = t.replace(/\b(\d[\d,]*(?:\.\d+)?)\s*(k|m|bn)\b/g, (_, a, s: string) => `${numberWords(a)} ${s === "k" ? "thousand" : s === "m" ? "million" : "billion"}`);
  // A year on its own
  t = t.replace(/\b(19\d{2}|20\d{2})\b(?![\d,.])/g, (_, y) => yearWords(Number(y)));
  // Any number left
  t = t.replace(/\b\d[\d,]*(?:\.\d+)?\b/g, (n) => numberWords(n));

  // Symbols
  t = t.replace(/\s+vs\.?\s+/gi, " versus ");
  t = t.replace(/\s*&\s*/g, " and ");
  t = t.replace(/\s*\+\s*/g, " plus ");
  t = t.replace(/(dollars?|cents?|thousand|million|billion|hundred|[a-z]+)\s*\/\s*(day|week|month|year|hour|click|lead|sale|order|person|user)\b/gi, "$1 per $2");
  t = t.replace(/([A-Za-z])\s*\/\s*([A-Za-z])/g, "$1 or $2");
  t = t.replace(/#(\w)/g, "number $1");
  t = t.replace(LETTER_RE, (_, abbr: string, s?: string) => `${abbr.split("").join(" ")}${s ? "s" : ""}`);

  t = t.replace(/\s+([,.!?;:])/g, "$1").replace(/\s+/g, " ").trim();
  // A sentence that only held a link: nothing else to say but where it is
  if (linked) t = /[a-z0-9]/i.test(t.replace(/[,.!?;:\s]/g, "")) ? `${t.replace(/[,;:\s]+$/, "")}${/[.!?]$/.test(t) ? "" : "."} ${LINK_LINE}` : LINK_LINE;
  return t;
}
