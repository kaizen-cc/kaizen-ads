import type { Block, Item, KDoc, KSection } from "./templates";

// A Kaizen document as HTML that Google Drive converts into a Google Doc, in the house style. Two looks:
//   sow   (Scope of Work, and every open document): a full red cover with the white Kaizen mark, "Kaizen x Client",
//         the engagement, the kicker, prepared for and by, "Get 1% better every day."; red-underlined H1s, red H2s,
//         red-header tables with zebra rows, grey callouts with a red bar.
//   quote (project quote): the Kaizen logo over a red bar, a red "KAIZEN MARKETING x CLIENT" eyebrow, the title,
//         numbered sections in red circles, a red TOTAL INVESTMENT bar, then an approval page with signatures.
// Drive's converter keeps inline styles on tables, cells and text (not page backgrounds), so the cover is a red table.
// The footer is set afterwards through the Docs API (src/lib/kaizen-docs/google.ts). Pure.

const RED = "#B21E2C";
const BLACK = "#060606";
const BODY = "#333333";
const GREY = "#F2F2F2";
const RULE = "#D9D9D9";
const MUTED = "#777777";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const P = (text: string, style = "") => `<p style="font-family:Arial;font-size:10.5pt;color:${BODY};line-height:1.45;margin:0 0 8pt 0;${style}">${text}</p>`;
const B = (s: string) => `<b style="color:${BLACK}">${esc(s)}</b>`;
const BREAK = `<p style="page-break-before:always;margin:0"></p>`;

function items(list: Item[], numbered = false) {
  const tag = numbered ? "ol" : "ul";
  return `<${tag} style="font-family:Arial;font-size:10.5pt;color:${BODY};margin:0 0 10pt 0">${list.map((i) => `<li style="margin:0 0 4pt 0;line-height:1.4">${i.lead ? `${B(i.lead)} ` : ""}${esc(i.text)}</li>`).join("")}</${tag}>`;
}

function table(head: string[], rows: string[][], total: string[] | null, headBg: string, headFg = "#ffffff") {
  const td = (c: string, i: number, o: { head?: boolean; fill?: string; bold?: boolean }) =>
    `<td style="border:1px solid ${RULE};padding:6pt 7pt;vertical-align:top;background-color:${o.head ? headBg : (o.fill ?? "#ffffff")};font-family:Arial;font-size:9.5pt;color:${o.head ? headFg : BODY};${o.head || o.bold ? "font-weight:bold;" : ""}${i === 0 && !o.head ? `color:${BLACK};` : ""}">${esc(c)}</td>`;
  return `<table style="border-collapse:collapse;width:100%;margin:4pt 0 12pt 0"><tr>${head.map((h, i) => td(h, i, { head: true })).join("")}</tr>${rows.map((r, n) => `<tr>${r.map((c, i) => td(c, i, { fill: n % 2 ? GREY : "#ffffff" })).join("")}</tr>`).join("")}${total ? `<tr>${total.map((c, i) => td(c, i, { fill: rows.length % 2 ? GREY : "#ffffff", bold: true })).join("")}</tr>` : ""}</table>`;
}

const callout = (text: string) => {
  const at = text.indexOf(":");
  const body = at > 0 && at < 50 ? `${B(text.slice(0, at + 1))}${esc(text.slice(at + 1))}` : esc(text);
  return `<table style="border-collapse:collapse;width:100%;margin:4pt 0 12pt 0"><tr><td width="1%" style="background-color:${RED};width:4pt;padding:0"></td><td width="99%" style="background-color:${GREY};padding:9pt 12pt;font-family:Arial;font-size:10.5pt;color:${BODY}">${body}</td></tr></table>`;
};

function stats(list: { value: string; label: string }[]) {
  return `<table style="border-collapse:collapse;width:100%;margin:6pt 0 12pt 0"><tr>${list.map((s) => `<td style="background-color:${RED};border:3px solid #ffffff;padding:10pt 6pt;text-align:center;vertical-align:middle"><p style="font-family:Arial;font-size:18pt;font-weight:bold;color:#ffffff;margin:0;text-align:center">${esc(s.value)}</p><p style="font-family:Arial;font-size:8.5pt;color:#ffffff;margin:2pt 0 0 0;text-align:center">${esc(s.label)}</p></td>`).join("")}</tr></table>`;
}

function gantt(weeks: number, rows: { task: string; start: number; end: number }[]) {
  const cell = (on: boolean) => `<td style="border:1px solid ${RULE};background-color:${on ? RED : "#ffffff"};padding:5pt 0;width:${Math.floor(60 / weeks)}%"></td>`;
  const head = `<tr><td style="border:1px solid ${RULE};background-color:${BLACK};color:#ffffff;font-family:Arial;font-size:9pt;font-weight:bold;padding:5pt 7pt">Phase</td>${Array.from({ length: weeks }, (_, i) => `<td style="border:1px solid ${RULE};background-color:${BLACK};color:#ffffff;font-family:Arial;font-size:8pt;font-weight:bold;text-align:center;padding:5pt 0">W${i + 1}</td>`).join("")}</tr>`;
  return `<table style="border-collapse:collapse;width:100%;margin:4pt 0 12pt 0">${head}${rows.map((r) => `<tr><td style="border:1px solid ${RULE};font-family:Arial;font-size:9.5pt;color:${BLACK};padding:5pt 7pt">${esc(r.task)}</td>${Array.from({ length: weeks }, (_, i) => cell(i + 1 >= r.start && i + 1 <= r.end)).join("")}</tr>`).join("")}</table>`;
}

function columns(cols: { heading: string; text: string; items: Item[] }[]) {
  return `<table style="border-collapse:collapse;width:100%;margin:4pt 0 10pt 0"><tr>${cols.map((c) => `<td style="vertical-align:top;padding:0 10pt 0 0;width:${Math.floor(100 / cols.length)}%">${c.heading ? `<p style="font-family:Arial;font-size:11.5pt;font-weight:bold;color:${RED};margin:0 0 6pt 0">${esc(c.heading)}</p>` : ""}${c.text ? P(esc(c.text)) : ""}${c.items.length ? items(c.items) : ""}</td>`).join("")}</tr></table>`;
}

function block(b: Block, look: "sow" | "quote"): string {
  switch (b.type) {
    case "paragraph":
      return P(esc(b.text));
    case "subheading":
      return `<p style="font-family:Arial;font-size:12pt;font-weight:bold;color:${look === "quote" ? BLACK : RED};margin:10pt 0 6pt 0">${esc(b.text)}</p>`;
    case "callout":
      return callout(b.text);
    case "bullets":
      return items(b.items);
    case "steps":
      return b.items.map((i, n) => `<p style="font-family:Arial;font-size:10.5pt;color:${BODY};margin:0 0 2pt 0"><b style="color:${RED}">${n + 1}.</b>&nbsp;&nbsp;${B(i.lead)}</p>${i.text ? P(esc(i.text), "margin-left:18pt") : ""}`).join("");
    case "stats":
      return stats(b.items);
    case "table":
      return look === "quote" ? table(b.head, b.rows, b.total, GREY, BLACK) : table(b.head, b.rows, b.total, RED);
    case "keyvalue":
      return `<table style="border-collapse:collapse;width:100%;margin:4pt 0 10pt 0">${b.rows.map((r) => `<tr><td width="30%" style="padding:4pt 10pt 4pt 0;vertical-align:top;width:30%;font-family:Arial;font-size:10.5pt;font-weight:bold;color:${BLACK}">${esc(r.label)}</td><td width="70%" style="padding:4pt 0;vertical-align:top;font-family:Arial;font-size:10.5pt;color:${BODY}">${esc(r.value)}</td></tr>`).join("")}</table>`;
    case "columns":
      return columns(b.columns);
    case "gantt":
      return gantt(b.weeks, b.rows);
    case "total":
      return `<table style="border-collapse:collapse;width:100%;margin:6pt 0 12pt 0"><tr><td style="background-color:${RED};padding:10pt 12pt;font-family:Arial;font-size:12pt;font-weight:bold;color:#ffffff">${esc(b.label)}</td><td style="background-color:${RED};padding:10pt 12pt;font-family:Arial;font-size:14pt;font-weight:bold;color:#ffffff;text-align:right">${esc(b.value)}</td></tr></table>`;
  }
}

// ─── The SOW look ───────────────────────────────────────────────────────────

function sowCover(d: KDoc, mark: string) {
  const line = (t: string, size: number, o = "") => `<p style="font-family:Arial;font-size:${size}pt;color:#ffffff;text-align:center;margin:0 0 6pt 0;${o}">${t}</p>`;
  const gap = (n: number) => Array.from({ length: n }, () => line("&nbsp;", 11)).join("");
  return `<table style="border-collapse:collapse;width:100%"><tr><td style="background-color:${RED};padding:30pt 24pt">${gap(6)}<p style="text-align:center;margin:0 0 30pt 0"><img src="${mark}" width="110" height="110" alt="Kaizen"></p>${line(esc(d.client ? `Kaizen x ${d.client}` : "Kaizen Marketing Agency"), 26, "font-weight:bold")}${line(esc(d.title), 15)}${gap(1)}${d.kicker ? line(esc(d.kicker), 11) : ""}${d.preparedFor ? line(`Prepared for ${esc(d.preparedFor)}`, 9.5) : ""}${gap(5)}${line(`Prepared by ${esc(d.preparedBy)} | ${esc(d.dated)}`, 9)}${line("<i>Get 1% better every day.</i>", 9)}${gap(4)}</td></tr></table>`;
}

const sowSection = (s: KSection) =>
  `<h1 style="font-family:Arial;font-size:20pt;font-weight:bold;color:${BLACK};margin:18pt 0 2pt 0;padding-bottom:4pt;border-bottom:2px solid ${RED}">${esc(s.heading)}</h1>${s.lede ? P(esc(s.lede), "margin-top:6pt") : ""}${s.blocks.map((b) => block(b, "sow")).join("")}`;

// ─── The quote look ─────────────────────────────────────────────────────────

function quoteHead(d: KDoc, logo: string) {
  return `<table style="border-collapse:collapse;width:100%"><tr><td style="padding:0 0 8pt 0;vertical-align:bottom"><img src="${logo}" width="120" height="34" alt="Kaizen"></td><td style="padding:0 0 8pt 0;text-align:right;vertical-align:bottom;font-family:Arial;font-size:8.5pt;color:${MUTED}">${esc(d.kicker || "Project Proposal")}<br>${d.client ? `Prepared for ${esc(d.client)}` : ""}</td></tr><tr><td colspan="2" style="background-color:${RED};padding:0;height:4pt;font-size:2pt">&nbsp;</td></tr></table>`;
}

const quoteSection = (s: KSection, n: number) =>
  `<table style="border-collapse:collapse;width:100%;margin:16pt 0 6pt 0"><tr><td width="7%" style="background-color:${RED};width:26pt;padding:5pt 0;text-align:center;font-family:Arial;font-size:10pt;font-weight:bold;color:#ffffff">${String(n).padStart(2, "0")}</td><td width="93%" style="padding:5pt 10pt;font-family:Arial;font-size:15pt;font-weight:bold;color:${BLACK};border-bottom:1px solid ${RULE}">${esc(s.heading)}</td></tr></table>${s.lede ? P(esc(s.lede)) : ""}${s.blocks.map((b) => block(b, "quote")).join("")}`;

function approval(d: KDoc) {
  const sign = (who: string) => `<td style="width:46%;vertical-align:top;padding:30pt 0 0 0;border-top:1px solid ${BLACK}"><p style="font-family:Arial;font-size:10pt;font-weight:bold;color:${BLACK};margin:0">${esc(who)}</p><p style="font-family:Arial;font-size:9pt;color:${MUTED};margin:2pt 0 0 0">Name, signature and date</p></td>`;
  return `${BREAK}<table style="border-collapse:collapse;width:100%;margin:0 0 10pt 0"><tr><td width="7%" style="background-color:${RED};width:26pt;padding:5pt 0;text-align:center;font-family:Arial;font-size:10pt;font-weight:bold;color:#ffffff">A</td><td width="93%" style="padding:5pt 10pt;font-family:Arial;font-size:15pt;font-weight:bold;color:${BLACK};border-bottom:1px solid ${RULE}">Approval of Proposal</td></tr></table>${P(`By signing below, ${esc(d.client ?? "the client")} approves the scope, timeline and investment in this proposal and authorizes Kaizen Marketing Agency to begin.`)}<table style="border-collapse:collapse;width:100%;margin-top:30pt"><tr>${sign(d.client ?? "Client")}<td style="width:8%"></td>${sign("Kaizen Marketing Agency")}</tr></table>`;
}

/** The document as HTML for Drive's converter. `assets` are public URLs of the marks. */
export function kdocHtml(d: KDoc, assets: { logo: string; markWhite: string }): string {
  let body: string;
  if (d.template === "quote") {
    body = `${quoteHead(d, assets.logo)}<p style="font-family:Arial;font-size:9pt;font-weight:bold;color:${RED};letter-spacing:1px;margin:14pt 0 4pt 0">${esc(d.client ? `KAIZEN MARKETING x ${d.client.toUpperCase()}` : "KAIZEN MARKETING")}</p><p style="font-family:Arial;font-size:26pt;font-weight:bold;color:${BLACK};margin:0 0 6pt 0">${esc(d.title)}</p>${d.subtitle ? P(esc(d.subtitle), `font-size:11pt;color:${MUTED}`) : ""}${d.sections.map((s, i) => quoteSection(s, i + 1)).join("")}${approval(d)}`;
  } else {
    body = `${sowCover(d, assets.markWhite)}${BREAK}${d.subtitle ? P(esc(d.subtitle), `font-size:11pt;color:${MUTED}`) : ""}${d.sections.map(sowSection).join("")}`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.title)}</title></head><body style="font-family:Arial">${body}</body></html>`;
}

/** The footer line: "Kaizen x Client | Scope of Work" or "kaizenmarketing.agency | This proposal is valid for 30 days" */
export function footerText(d: KDoc): string {
  if (d.template === "quote") return "kaizenmarketing.agency   |   This proposal is valid for 30 days";
  return `${d.client ? `Kaizen x ${d.client}` : "Kaizen Marketing Agency"} | ${d.template === "sow" ? "Scope of Work" : d.title}  `;
}
