// The email design studio's plain helpers, shared by the server (the Kaizen AI tools, the preview routes) and the
// tests: making a design's HTML safe, moving its CSS inline the way email clients need, checking it against the
// production rules (600px, alt text, preheader, dark mode, Gmail's size limit), the dark mode preview, what a past
// campaign looks like in a few lines, and the design notes in a Brand Bible. No keys, no calls.

/** The widths the preview shows: an email at its desktop width, and a phone */
export const PREVIEW_WIDTHS = { desktop: 600, mobile: 375 } as const;
export type PreviewWidth = keyof typeof PREVIEW_WIDTHS;

/** How much to shrink a preview of this width to fit the space there is (never larger than life) */
export function previewScale(available: number, width: number): number {
  if (!Number.isFinite(available) || available <= 0 || width <= 0) return 1;
  return Math.min(1, Math.round((available / width) * 1000) / 1000);
}

/** Gmail cuts an email off ("[Message clipped]") past about 102 KB of HTML */
export const GMAIL_CLIP_BYTES = 102_000;

// ─── Safe HTML ──────────────────────────────────────────────────────────────

/**
 * The design's HTML with anything that could run code taken out (scripts, frames, plugins, forms, event handlers,
 * javascript: links, CSS expressions), keeping what email needs: <style> blocks, media queries, Outlook's conditional
 * comments and VML buttons, and the email platform's merge tags.
 */
export function cleanEmailHtml(raw: string): string {
  let h = String(raw ?? "");
  // A model's answer sometimes comes wrapped in a code fence
  h = h.replace(/^\s*```(?:html)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  h = h.replace(/<(script|iframe|frame|frameset|object|embed|applet|form|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, "");
  h = h.replace(/<\/?(script|iframe|frame|frameset|object|embed|applet|form|input|textarea|select|base|portal)\b[^>]*>/gi, "");
  h = h.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, "");
  h = h.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  h = h.replace(/\s(href|src|action|formaction|xlink:href|background|poster)\s*=\s*("|')\s*(javascript|vbscript|data:text\/html)[^"']*\2/gi, ' $1="#"');
  h = h.replace(/\s(href|src|action|formaction|background)\s*=\s*(javascript|vbscript):[^\s>]*/gi, ' $1="#"');
  h = h.replace(/expression\s*\(/gi, "(").replace(/url\(\s*["']?\s*javascript:[^)]*\)/gi, "none");
  return h.trim();
}

/** The email platform's merge tags as something a preview can show ({{ first_name }} as "there", links as #) */
export function previewMergeTags(html: string): string {
  return html
    .replace(/\{%\s*(unsubscribe|manage_preferences|web_view)[^%]*%\}/gi, "#")
    .replace(/\{%[\s\S]*?%\}/g, "")
    .replace(/\{\{\s*([^}|]*?)(\|[^}]*)?\s*\}\}/g, (_m, name: string) => {
      const key = name.trim().toLowerCase();
      if (/first_name/.test(key)) return "there";
      if (/url|link/.test(key)) return "#";
      return "";
    });
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A whole document: the doctype, the head email clients expect (charset, viewport, the colour schemes it supports,
 * the subject as its title) and the preheader as the first hidden line of the body when it isn't there yet.
 */
export function ensureDocument(raw: string, opts: { title?: string | null; preheader?: string | null } = {}): string {
  let h = raw.trim();
  if (!/<html[\s>]/i.test(h)) h = `<html><head></head><body>${h.replace(/<\/?body[^>]*>/gi, "")}</body></html>`;
  if (!/<head[\s>]/i.test(h)) h = h.replace(/<html([^>]*)>/i, "<html$1><head></head>");
  if (!/<body[\s>]/i.test(h)) h = h.replace(/<\/head>/i, "</head><body>").replace(/<\/html>/i, "</body></html>");
  if (!/^<!doctype/i.test(h)) h = `<!DOCTYPE html>\n${h}`;
  if (!/<html[^>]*\blang=/i.test(h)) h = h.replace(/<html/i, '<html lang="en"');
  const add: string[] = [];
  if (!/<meta[^>]*charset/i.test(h)) add.push('<meta charset="utf-8">');
  if (!/<meta[^>]*name=["']viewport/i.test(h)) add.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  if (!/<meta[^>]*name=["']color-scheme/i.test(h)) add.push('<meta name="color-scheme" content="light dark">');
  if (!/<meta[^>]*name=["']supported-color-schemes/i.test(h)) add.push('<meta name="supported-color-schemes" content="light dark">');
  if (opts.title && !/<title>/i.test(h)) add.push(`<title>${esc(opts.title)}</title>`);
  if (add.length) h = h.replace(/<head([^>]*)>/i, `<head$1>\n${add.join("\n")}`);
  if (opts.preheader && !hasPreheader(h)) {
    // Hidden text the inbox shows after the subject, padded so the body copy doesn't run on after it
    const pad = "&#8199;&#65279;&#847; ".repeat(40);
    h = h.replace(/<body([^>]*)>/i, `<body$1>\n<div class="preheader" style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${esc(opts.preheader)}${pad}</div>`);
  }
  return h;
}

/** Whether the body opens with a hidden preheader line */
export function hasPreheader(html: string): boolean {
  const body = html.split(/<body[^>]*>/i)[1] ?? html;
  const start = body.slice(0, 4000);
  return /class=["'][^"']*preheader/i.test(start) || /<(div|span)[^>]*style=["'][^"']*display\s*:\s*none[^"']*["'][^>]*>\s*[^<\s]/i.test(start);
}

// ─── CSS inlining ───────────────────────────────────────────────────────────

/** A stylesheet's top-level statements: plain rules, and at-rules (media queries) whole */
export function cssStatements(css: string): { head: string; body: string; at: boolean }[] {
  const out: { head: string; body: string; at: boolean }[] = [];
  const s = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf("{", i);
    if (open < 0) break;
    const head = s.slice(i, open).trim();
    // An at-rule with no block (@import ... ;) before this rule
    const semi = head.lastIndexOf(";");
    const sel = semi >= 0 && head.startsWith("@") ? head.slice(semi + 1).trim() : head;
    let depth = 1;
    let j = open + 1;
    for (; j < s.length && depth > 0; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}") depth--;
    }
    out.push({ head: sel, body: s.slice(open + 1, j - 1).trim(), at: sel.startsWith("@") });
    i = j;
  }
  return out;
}

/** Declarations as pairs, splitting on semicolons outside brackets (a data: address has one) */
export function declarations(body: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let cur = "";
  for (const c of body) {
    if (c === "(") depth++;
    if (c === ")") depth = Math.max(0, depth - 1);
    if (c === ";" && depth === 0) {
      push(cur);
      cur = "";
    } else cur += c;
  }
  push(cur);
  return out;
  function push(d: string) {
    const k = d.indexOf(":");
    if (k <= 0) return;
    const prop = d.slice(0, k).trim().toLowerCase();
    const value = d.slice(k + 1).trim();
    if (prop && value) out.push([prop, value]);
  }
}

type Rule = { tag: string | null; cls: string | null; id: string | null; spec: number; order: number; decls: [string, string][] };

/** A selector simple enough to inline (p, .x, #x, td.x); anything else (descendants, :hover, attributes) stays in <style> */
function simple(sel: string): Omit<Rule, "order" | "decls"> | null {
  const m = sel.trim().match(/^([a-z][a-z0-9]*)?(?:\.([\w-]+))?(?:#([\w-]+))?$/i);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const [, tag, cls, id] = m;
  if (tag && /^(html|head|style|meta|title)$/i.test(tag)) return null;
  return { tag: tag?.toLowerCase() ?? null, cls: cls ?? null, id: id ?? null, spec: (id ? 100 : 0) + (cls ? 10 : 0) + (tag ? 1 : 0) };
}

const attrOf = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));

/**
 * The CSS in <style> blocks moved onto the elements it styles, as email clients that drop <style> need. Simple rules
 * (a tag, a class, an id, or tag.class) are inlined in order of specificity, and what an element already has inline
 * wins. Media queries, :hover, dark mode and anything more complex stay in the <style> block for the clients that read it.
 */
export function inlineCss(html: string): string {
  const rules: Rule[] = [];
  let order = 0;
  const withStyles = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_m, attrs: string, css: string) => {
    const keep: string[] = [];
    for (const st of cssStatements(css)) {
      if (st.at) {
        keep.push(`${st.head}{${st.body}}`);
        continue;
      }
      const sels = st.head.split(",").map((x) => x.trim());
      const parsed = sels.map(simple);
      const decls = declarations(st.body);
      // !important lines stay in the sheet too, as they're there to beat a client's own styles
      const important = decls.some(([, v]) => /!important/i.test(v));
      parsed.forEach((p) => p && rules.push({ ...p, order: order++, decls: decls.map(([k, v]) => [k, v.replace(/\s*!important/i, "")]) }));
      const rest = sels.filter((_, i) => !parsed[i] || important);
      if (rest.length) keep.push(`${rest.join(",")}{${st.body}}`);
    }
    return keep.length ? `<style${attrs}>\n${keep.join("\n")}\n</style>` : "";
  });
  if (!rules.length) return withStyles;
  rules.sort((a, b) => a.spec - b.spec || a.order - b.order);
  const parts = withStyles.split(/(<body[^>]*>)/i);
  const at = parts.length > 1 ? 2 : 0;
  const head = parts.slice(0, at).join("");
  const body = parts.slice(at).join("");
  const done = body.replace(/<([a-z][a-z0-9]*)(\s[^<>]*?)?(\/?)>/gi, (whole, tagName: string, attrs = "", slash: string) => {
    const tag = tagName.toLowerCase();
    if (/^(style|script|title|meta)$/.test(tag)) return whole;
    const classes = (attrOf(attrs, "class")?.slice(2).find((x) => x != null) ?? "").split(/\s+/).filter(Boolean);
    const id = attrOf(attrs, "id")?.slice(2).find((x) => x != null) ?? null;
    const hit = rules.filter((r) => (!r.tag || r.tag === tag) && (!r.cls || classes.includes(r.cls)) && (!r.id || r.id === id));
    if (!hit.length) return whole;
    const merged = new Map<string, string>();
    for (const r of hit) for (const [k, v] of r.decls) merged.set(k, v);
    const existing = attrOf(attrs, "style");
    const own = existing ? (existing.slice(2).find((x) => x != null) ?? "") : "";
    for (const [k, v] of declarations(own)) merged.set(k, v);
    const style = [...merged].map(([k, v]) => `${k}:${v.replace(/"/g, "'")}`).join(";");
    const rest = existing ? attrs.replace(existing[0], "") : attrs;
    return `<${tagName}${rest} style="${style}"${slash ? " /" : ""}>`;
  });
  return head + done;
}

// ─── Checks ─────────────────────────────────────────────────────────────────

export type DesignCheck = { ok: boolean; text: string };

/** The production checks shown on the card: what's right, and what to fix before it's built */
export function checkEmail(html: string): DesignCheck[] {
  const out: DesignCheck[] = [];
  const bytes = new TextEncoder().encode(html).length;
  out.push(bytes > GMAIL_CLIP_BYTES ? { ok: false, text: `${Math.round(bytes / 1000)} KB: Gmail clips past 102 KB, so trim it` } : { ok: true, text: `${Math.round(bytes / 1000)} KB, under Gmail's 102 KB clip` });
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const noAlt = imgs.filter((t) => !/\salt\s*=/i.test(t)).length;
  out.push(noAlt ? { ok: false, text: `${noAlt} of ${imgs.length} images have no alt text` } : { ok: true, text: imgs.length ? `Alt text on all ${imgs.length} images` : "No images: it reads with images off" });
  out.push(hasPreheader(html) ? { ok: true, text: "Preheader set" } : { ok: false, text: "No preheader: the inbox will show the first line of the body" });
  const darkRules = /prefers-color-scheme\s*:\s*dark/i.test(html);
  out.push(darkRules ? { ok: true, text: "Dark mode styles included" } : { ok: false, text: "No dark mode styles: clients will invert its colours on their own" });
  const widths = [...html.matchAll(/<(?:table|td|div|img)\b[^>]*?(?:\swidth\s*=\s*["']?(\d+)|max-width\s*:\s*(\d+)px|[;"\s]width\s*:\s*(\d+)px)/gi)].map((m) => Number(m[1] ?? m[2] ?? m[3]));
  const wide = widths.filter((w) => w > 600);
  out.push(wide.length ? { ok: false, text: `Something is ${Math.max(...wide)}px wide; keep the email at 600px` } : { ok: true, text: "600px wide at most" });
  const vml = /v:roundrect/i.test(html);
  const buttons = [...html.matchAll(/<a\b[^>]*style=["'][^"']*(?:background|padding)[^"']*["'][^>]*>/gi)].length;
  if (buttons) out.push(vml ? { ok: true, text: "Bulletproof buttons (with Outlook's VML)" } : { ok: true, text: `${buttons} HTML buttons (no images to load)` });
  out.push(/unsubscribe/i.test(html) ? { ok: true, text: "Unsubscribe link in the footer" } : { ok: false, text: "No unsubscribe link: add {% unsubscribe %} in the footer" });
  return out;
}

// ─── Dark mode preview ──────────────────────────────────────────────────────

/** The rules inside the email's dark mode media queries, as one sheet */
export function darkRules(html: string): string {
  const out: string[] = [];
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
    for (const st of cssStatements(m[1])) if (/^@media[^{]*prefers-color-scheme\s*:\s*dark/i.test(st.head)) out.push(st.body);
  return out.join("\n");
}

/**
 * The email as it shows in dark mode: its own dark styles applied (as Apple Mail and the Outlook apps do), and the
 * Outlook.com form ([data-ogsc]) too. With no dark styles of its own, the full colour flip some clients (the Gmail apps)
 * make, pictures kept as they are.
 */
export function forceDark(html: string): { html: string; mode: "own" | "inverted" } {
  const rules = darkRules(html);
  const inject = (h: string, css: string) => (/<\/head>/i.test(h) ? h.replace(/<\/head>/i, `<style>${css}</style></head>`) : `<style>${css}</style>${h}`);
  if (rules.trim()) {
    const withAttr = html.replace(/<body([^>]*)>/i, (m, a: string) => (/data-ogsc/.test(a) ? m : `<body${a} data-ogsc data-ogsb>`));
    return { html: inject(withAttr, rules), mode: "own" };
  }
  return { html: inject(html, "html{filter:invert(1) hue-rotate(180deg);background:#fff}img,video,[style*='background-image']{filter:invert(1) hue-rotate(180deg)}"), mode: "inverted" };
}

/** What the preview frame shows: the design made safe, merge tags filled, links opening outside, dark when asked */
export function previewHtml(html: string, opts: { dark?: boolean } = {}): string {
  let h = previewMergeTags(cleanEmailHtml(html));
  const base = '<base target="_blank"><style>html,body{margin:0}img{max-width:100%}</style>';
  h = /<head[^>]*>/i.test(h) ? h.replace(/<head([^>]*)>/i, `<head$1>${base}`) : `${base}${h}`;
  return opts.dark ? forceDark(h).html : h;
}

/** The Content-Security-Policy every preview is served with: no scripts, no forms, nothing loaded but pictures and fonts */
export const PREVIEW_CSP =
  "default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com https: data:; frame-ancestors 'self'; form-action 'none'; base-uri 'none'; sandbox allow-popups allow-popups-to-escape-sandbox";

// ─── Reading past emails and the Brand Bible ────────────────────────────────

const count = <T>(xs: T[]) => {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};

/** What a sent email looks like in a few lines (its colours, fonts, width and the order of its blocks), for the designer to match */
export function designDigest(html: string): string {
  const h = html.replace(/<!--[\s\S]*?-->/g, "");
  const colors = count([...h.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)].map((m) => `#${(m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1]).toLowerCase()}`)).slice(0, 8);
  const fonts = count([...h.matchAll(/font-family\s*:\s*([^;"}]+)/gi)].map((m) => m[1].trim().replace(/&quot;|"/g, "'").replace(/\s+/g, " "))).slice(0, 4);
  const googleFonts = [...h.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^"'&]+)/gi)].map((m) => decodeURIComponent(m[1]).replace(/\+/g, " ").split(":")[0]);
  const sizes = count([...h.matchAll(/font-size\s*:\s*(\d+)px/gi)].map((m) => Number(m[1]))).slice(0, 6).map(([s]) => s).sort((a, b) => b - a);
  const radius = count([...h.matchAll(/border-radius\s*:\s*(\d+)px/gi)].map((m) => Number(m[1])))[0]?.[0];
  const width = Math.max(0, ...[...h.matchAll(/(?:\swidth\s*=\s*["']?|max-width\s*:\s*)(\d{3})/gi)].map((m) => Number(m[1])).filter((w) => w <= 800));
  // The blocks in order: pictures, headings, buttons, text, collapsed when they repeat
  const blocks: string[] = [];
  for (const m of h.matchAll(/<(img|h[1-3]|a|p)\b([^>]*)>/gi)) {
    const tag = m[1].toLowerCase();
    const kind = tag === "img" ? "image" : tag.startsWith("h") ? "heading" : tag === "a" ? (/background|padding/i.test(m[2]) ? "button" : null) : "text";
    if (!kind) continue;
    if (blocks.at(-1)?.replace(/ x\d+$/, "") === kind) {
      const last = blocks.pop()!;
      const n = Number(last.match(/ x(\d+)$/)?.[1] ?? 1) + 1;
      blocks.push(`${kind} x${n}`);
    } else blocks.push(kind);
  }
  const text = h
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#\d+;|&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [
    colors.length ? `Colours (most used first): ${colors.map(([c]) => c).join(", ")}` : null,
    fonts.length || googleFonts.length ? `Fonts: ${[...new Set([...googleFonts, ...fonts.map(([f]) => f)])].join(" | ")}` : null,
    sizes.length ? `Type sizes: ${sizes.join(", ")}px` : null,
    radius != null ? `Corner radius: ${radius}px` : null,
    width ? `Width: ${width}px` : null,
    blocks.length ? `Layout, top to bottom: ${blocks.slice(0, 24).join(" > ")}` : null,
    text ? `Words: ${text.slice(0, 500)}${text.length > 500 ? "…" : ""}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The parts of a Brand Bible about how the brand looks (colours, fonts, logo, imagery, style, email), else its opening */
export function bibleDesignNotes(markdown: string | null | undefined, max = 6000): string {
  const md = String(markdown ?? "").trim();
  if (!md) return "";
  const sections = md.split(/\n(?=#{1,4}\s)/);
  const look = /(visual|design|colou?r|palette|font|typ(e|ography)|logo|imagery|photo|style|look|aesthetic|email|layout|brand identity)/i;
  const hit = sections.filter((s) => look.test(s.split("\n")[0] ?? ""));
  const text = (hit.length ? hit.join("\n\n") : md).trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A file name for the downloaded email: the client, the title and the version */
export function designFileName(client: string | null, title: string, version: number): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_-]+/g, "-")
      .slice(0, 48)
      .replace(/-+$/, "");
  return [client ? slug(client) : null, slug(title) || "email", `v${version}`].filter(Boolean).join("-") + ".html";
}

/** The design's production HTML: safe, whole, CSS inline, the preheader in place */
export function finishEmailHtml(raw: string, opts: { subject?: string | null; preheader?: string | null } = {}): string {
  return inlineCss(ensureDocument(cleanEmailHtml(raw), { title: opts.subject, preheader: opts.preheader }));
}
