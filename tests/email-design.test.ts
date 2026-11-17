import { describe, expect, it } from "vitest";
import {
  bibleDesignNotes,
  checkEmail,
  cleanEmailHtml,
  cssStatements,
  declarations,
  designDigest,
  designFileName,
  ensureDocument,
  finishEmailHtml,
  forceDark,
  hasPreheader,
  inlineCss,
  PREVIEW_WIDTHS,
  previewHtml,
  previewMergeTags,
  previewScale,
} from "@/lib/email-design/core";
import { previewToken, readPreviewToken } from "@/lib/email-design/token";

describe("preview widths", () => {
  it("shows desktop at 600 and a phone at 375", () => {
    expect(PREVIEW_WIDTHS).toEqual({ desktop: 600, mobile: 375 });
  });
  it("shrinks to fit, never grows", () => {
    expect(previewScale(300, 600)).toBe(0.5);
    expect(previewScale(900, 600)).toBe(1);
    expect(previewScale(0, 600)).toBe(1);
    expect(previewScale(NaN, 375)).toBe(1);
  });
});

describe("safe HTML", () => {
  it("takes out anything that runs code", () => {
    const h = cleanEmailHtml(`<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">a</a><iframe src="x"></iframe><form><input></form><div style="width:expression(alert(1))"></div>`);
    expect(h).not.toMatch(/script|onclick|javascript:|iframe|<form|<input|expression\(/i);
    expect(h).toContain("<p>Hi</p>");
  });
  it("keeps what email needs: styles, Outlook comments and VML, merge tags", () => {
    const src = `<style>@media (max-width:600px){.c{width:100%!important}}</style><!--[if mso]><v:roundrect href="#"></v:roundrect><![endif]--><p>{{ first_name|default:'there' }}</p><a href="{% unsubscribe %}">Unsubscribe</a>`;
    const h = cleanEmailHtml(src);
    expect(h).toContain("@media");
    expect(h).toContain("<!--[if mso]>");
    expect(h).toContain("v:roundrect");
    expect(h).toContain("{% unsubscribe %}");
  });
  it("drops a code fence around the answer", () => {
    expect(cleanEmailHtml("```html\n<p>x</p>\n```")).toBe("<p>x</p>");
  });
  it("fills merge tags for the preview", () => {
    expect(previewMergeTags(`Hi {{ first_name|default:'there' }} <a href="{% unsubscribe %}">u</a> {% if x %}y{% endif %}`)).toBe(`Hi there <a href="#">u</a> y`);
  });
});

describe("document and preheader", () => {
  it("wraps a fragment as a whole email with the head email clients expect", () => {
    const h = ensureDocument("<table><tr><td>Hi</td></tr></table>", { title: "Spring sale", preheader: "20% off this weekend" });
    expect(h.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(h).toMatch(/<meta charset="utf-8">/);
    expect(h).toMatch(/name="viewport"/);
    expect(h).toMatch(/name="color-scheme" content="light dark"/);
    expect(h).toContain("<title>Spring sale</title>");
    expect(hasPreheader(h)).toBe(true);
    expect(h.indexOf("20% off")).toBeLessThan(h.indexOf("<table"));
  });
  it("doesn't add a second preheader", () => {
    const once = ensureDocument("<html><head></head><body><table></table></body></html>", { preheader: "P" });
    expect(ensureDocument(once, { preheader: "P" }).match(/class="preheader"/g)).toHaveLength(1);
  });
});

describe("CSS inlining", () => {
  it("splits a sheet into rules and media queries", () => {
    const st = cssStatements("p{color:red} @media (max-width:600px){ .a{width:100%} } .b{x:y}");
    expect(st.map((s) => s.head)).toEqual(["p", "@media (max-width:600px)", ".b"]);
    expect(st[1].at).toBe(true);
  });
  it("splits declarations outside brackets", () => {
    expect(declarations("background:url(data:image/png;base64,AAA);color:#fff")).toEqual([
      ["background", "url(data:image/png;base64,AAA)"],
      ["color", "#fff"],
    ]);
  });
  it("moves simple rules inline by specificity, inline style wins, media queries stay", () => {
    const h = inlineCss(`<html><head><style>p{color:#111;font-size:16px} .lead{font-size:20px} #hero{margin:0} a:hover{color:red} @media (max-width:600px){.lead{font-size:18px!important}}</style></head><body><p class="lead" style="color:#222">Hi</p><p id="hero">Yo</p><a href="#">x</a></body></html>`);
    expect(h).toContain('<p class="lead" style="color:#222;font-size:20px">');
    expect(h).toContain('<p id="hero" style="color:#111;font-size:16px;margin:0">');
    expect(h).toContain("a:hover{color:red}");
    expect(h).toContain("@media (max-width:600px)");
    expect(h).not.toMatch(/<style>[^<]*\.lead\{font-size:20px\}/);
  });
  it("leaves HTML without styles alone", () => {
    expect(inlineCss("<p>x</p>")).toBe("<p>x</p>");
  });
});

describe("production checks", () => {
  const good = finishEmailHtml(
    `<html><head><style>@media (prefers-color-scheme: dark){.bg{background:#111!important}}</style></head><body><table width="600" role="presentation"><tr><td><img src="https://x/a.png" alt="Shoes" width="600"><a href="#" style="background:#000;padding:14px 24px;color:#fff">Shop</a><a href="{% unsubscribe %}">Unsubscribe</a></td></tr></table></body></html>`,
    { subject: "S", preheader: "Pre" },
  );
  it("passes a well-built email", () => {
    expect(checkEmail(good).filter((c) => !c.ok)).toEqual([]);
  });
  it("flags missing alt text, preheader, dark mode, unsubscribe, a wide table and a heavy file", () => {
    const bad = `<table width="700"><tr><td><img src="x.png">${"x".repeat(110_000)}</td></tr></table>`;
    const fails = checkEmail(bad)
      .filter((c) => !c.ok)
      .map((c) => c.text);
    expect(fails.some((t) => /alt text/.test(t))).toBe(true);
    expect(fails.some((t) => /preheader/i.test(t))).toBe(true);
    expect(fails.some((t) => /dark mode/i.test(t))).toBe(true);
    expect(fails.some((t) => /unsubscribe/i.test(t))).toBe(true);
    expect(fails.some((t) => /700px/.test(t))).toBe(true);
    expect(fails.some((t) => /102 KB/.test(t))).toBe(true);
  });
});

describe("dark mode preview", () => {
  it("applies the email's own dark rules", () => {
    const r = forceDark(`<html><head><style>@media (prefers-color-scheme: dark){.bg{background:#111!important}}</style></head><body><p>x</p></body></html>`);
    expect(r.mode).toBe("own");
    expect(r.html).toMatch(/<style>\.bg\{background:#111!important\}<\/style><\/head>/);
    expect(r.html).toContain("data-ogsc");
  });
  it("flips colours when the email has no dark rules", () => {
    const r = forceDark("<html><head></head><body><p>x</p></body></html>");
    expect(r.mode).toBe("inverted");
    expect(r.html).toContain("invert(1)");
  });
  it("the preview opens links outside and is safe", () => {
    const h = previewHtml(`<html><head></head><body><script>x</script><a href="{% web_view %}">v</a></body></html>`, { dark: true });
    expect(h).toContain('<base target="_blank">');
    expect(h).not.toContain("<script");
    expect(h).toContain('href="#"');
  });
});

describe("reading past emails and the Brand Bible", () => {
  it("sums up a sent email's look", () => {
    const d = designDigest(`<table width="600"><tr><td style="font-family:'Playfair Display', Georgia, serif;color:#1A2B3C;font-size:32px"><img src="a.png"><img src="b.png"><h1>Big</h1><p>Copy</p><a style="background:#ff6600;border-radius:8px;padding:12px">Shop</a></td></tr></table>`);
    expect(d).toMatch(/#1a2b3c/);
    expect(d).toMatch(/#ff6600/);
    expect(d).toMatch(/Playfair Display/);
    expect(d).toMatch(/Width: 600px/);
    expect(d).toMatch(/Corner radius: 8px/);
    expect(d).toMatch(/image x2 > heading > text > button/);
  });
  it("keeps the Bible's sections about the look", () => {
    const md = "# Brand\nIntro\n## Voice\nWarm\n## Visual identity\nColours: #112233\n## Typography\nFonts: Inter\n## Offers\n10% off";
    const notes = bibleDesignNotes(md);
    expect(notes).toContain("Visual identity");
    expect(notes).toContain("Typography");
    expect(notes).not.toContain("Warm");
    expect(notes).not.toContain("10% off");
    expect(bibleDesignNotes("Just text, no headings")).toBe("Just text, no headings");
    expect(bibleDesignNotes(null)).toBe("");
  });
  it("names the downloaded file", () => {
    expect(designFileName("Sierra Dreams", "Spring Sale: 20% off!", 2)).toBe("sierra-dreams-spring-sale-20-off-v2.html");
    expect(designFileName(null, "", 1)).toBe("email-v1.html");
  });
});

describe("public preview links", () => {
  const id = "0b9d6b4e-8f2a-4c1e-9a77-1d2e3f4a5b6c";
  it("reads back a link it signed", () => {
    const t = previewToken("secret", { id, version: 3 }, 1_000);
    expect(readPreviewToken("secret", t, 2_000)).toEqual({ id, version: 3 });
  });
  it("refuses a link after a week, with another key, or tampered", () => {
    const t = previewToken("secret", { id, version: 1 }, 0);
    expect(readPreviewToken("secret", t, 8 * 86_400_000)).toBeNull();
    expect(readPreviewToken("other", t, 1)).toBeNull();
    expect(readPreviewToken("secret", `${t}x`, 1)).toBeNull();
    expect(readPreviewToken("", t, 1)).toBeNull();
  });
});
