import "server-only";
import { siteUrl } from "@/lib/site";

// Every email a client gets from Kaizen, in the website's look: light (#fafafa page, a white card), the red logo, a
// bold black headline with an optional word in a red highlight (as on kaizenmarketing.agency), short lines, numbered
// steps or bullets instead of paragraphs, and one red button. Tables and inline styles, so every mail app shows it.

const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
const BRAND = "#b21e2c";
const INK = "#111111";
const BODY = "#3a3a3a";
const MUTED = "#6b6b6b";
const FONT = "Poppins,'Helvetica Neue',Helvetica,Arial,sans-serif";
const HEAD = "'GT Flexa','Helvetica Neue',Helvetica,Arial,sans-serif";

export type EmailParts = {
  /** Shown in the inbox under the subject */
  preheader?: string;
  kicker?: string;
  title: string;
  /** One word or phrase of the title shown in the red highlight */
  highlight?: string;
  hello?: string;
  lines?: string[];
  /** Numbered steps, each a bold line and a short explanation */
  steps?: { title: string; text?: string }[];
  bullets?: string[];
  cta?: { label: string; url: string };
  note?: string;
  /** A white label client's email: the same layout in a neutral slate, with no agency logo, name or footer */
  whiteLabel?: boolean;
};

export function emailHtml(p: EmailParts) {
  const RED = p.whiteLabel ? "#334155" : BRAND;
  const title = esc(p.title);
  const titled = p.highlight && p.title.includes(p.highlight) ? title.replace(esc(p.highlight), `<span style="background:${RED};color:#ffffff;padding:0 6px;border-radius:2px">${esc(p.highlight)}</span>`) : title;
  const steps = p.steps?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:6px 0 22px">${p.steps
        .map(
          (s, i) => `<tr><td valign="top" width="40" style="padding:0 0 14px"><div style="width:28px;height:28px;border-radius:999px;background:${RED};color:#ffffff;font:600 13px/28px ${FONT};text-align:center">${i + 1}</div></td><td valign="top" style="padding:3px 0 14px;font:15px/1.5 ${FONT};color:${BODY}"><b style="color:${INK}">${esc(s.title)}</b>${s.text ? `<br><span style="color:${MUTED};font-size:14px">${esc(s.text)}</span>` : ""}</td></tr>`,
        )
        .join("")}</table>`
    : "";
  const bullets = p.bullets?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:4px 0 20px">${p.bullets.map((b) => `<tr><td valign="top" width="20" style="padding:0 0 8px;color:${RED};font:700 15px/1.5 ${FONT}">•</td><td style="padding:0 0 8px;font:15px/1.5 ${FONT};color:${BODY}">${esc(b)}</td></tr>`).join("")}</table>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head><body style="margin:0;padding:0;background:#fafafa">
${p.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(p.preheader)}</div>` : ""}
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#fafafa"><tr><td align="center" style="padding:32px 14px">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px">
${p.whiteLabel ? "" : `<tr><td style="padding:0 6px 18px"><img src="${siteUrl()}/kaizen-logo.png" width="112" height="31" alt="Kaizen" style="display:block;border:0"></td></tr>`}
<tr><td style="background:#ffffff;border:1px solid #ececec;border-radius:14px;padding:32px 30px">
${p.kicker ? `<p style="margin:0 0 12px;font:600 11px/1.4 ${FONT};letter-spacing:.16em;text-transform:uppercase;color:${RED}">${esc(p.kicker)}</p>` : ""}
<h1 style="margin:0 0 18px;font:700 26px/1.25 ${HEAD};color:#000000;letter-spacing:-.01em">${titled}</h1>
${p.hello ? `<p style="margin:0 0 12px;font:15px/1.55 ${FONT};color:${INK}">${esc(p.hello)}</p>` : ""}
${(p.lines ?? []).map((l) => `<p style="margin:0 0 14px;font:15px/1.6 ${FONT};color:${BODY}">${esc(l)}</p>`).join("")}
${steps}${bullets}
${p.cta ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 4px"><tr><td style="background:${RED};border-radius:4px"><a href="${esc(p.cta.url)}" style="display:inline-block;padding:14px 26px;font:600 15px/1 ${FONT};color:#ffffff;text-decoration:none">${esc(p.cta.label)}</a></td></tr></table>` : ""}
${p.note ? `<p style="margin:20px 0 0;font:12.5px/1.55 ${FONT};color:${MUTED}">${esc(p.note)}</p>` : ""}
</td></tr>
${p.whiteLabel ? "" : `<tr><td style="padding:18px 6px 0;font:12px/1.5 ${FONT};color:#9a9a9a">Kaizen Marketing · Get 1% better every day.</td></tr>`}
</table></td></tr></table></body></html>`;
}

/** The same email as plain text */
export function emailText(p: EmailParts) {
  return [
    p.hello,
    p.hello ? "" : null,
    ...(p.lines ?? []).flatMap((l) => [l, ""]),
    ...(p.steps ?? []).map((s, i) => `${i + 1}. ${s.title}${s.text ? `: ${s.text}` : ""}`),
    p.steps?.length ? "" : null,
    ...(p.bullets ?? []).map((b) => `• ${b}`),
    p.bullets?.length ? "" : null,
    p.cta ? `${p.cta.label}: ${p.cta.url}` : null,
    p.cta ? "" : null,
    p.note ?? null,
    p.whiteLabel ? null : "",
    p.whiteLabel ? null : "— The Kaizen team",
  ]
    .filter((x) => x != null)
    .join("\n");
}
