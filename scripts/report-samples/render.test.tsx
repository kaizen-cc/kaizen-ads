import fs from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import sharp from "sharp";
import { renderToBuffer } from "@react-pdf/renderer";
import { ReportDocument, type ReportPart, type ReportPdfInput } from "@/lib/reports/report-doc";
import { logoCandidates, processLogo } from "@/lib/reports/brand-server";
import type { ReportMetrics } from "@/lib/reports/metrics";
import { emptySections, googleWithUnits, harborMeta, harborTiktok, northsideMeta, oceanboxGoogle, oceanboxMeta, oceanboxMetaSections } from "../../tests/fixtures/report-weekly";

// Renders the weekly report samples (PDF and a PNG per page) into docs/report-samples: OceanBox's real Meta and Google
// weeks, a TikTok week, a joint Meta + TikTok week and a white label one. Run on its own:
//   npx vitest run --config scripts/report-samples/vitest.config.mts
// OceanBox's logo is read from its website the way the report finds it (the reference report's copy if the site can't
// be reached); the made-up clients get a drawn wordmark.

const OUT = path.resolve(__dirname, "../../docs/report-samples");
const REAL_ADS: Record<string, string> = {
  "120236318449120407": "https://scontent-lga3-1.xx.fbcdn.net/v/t15.5256-10/596137748_1342274940721077_856957059972266803_n.jpg?_nc_cat=110&ccb=1-7&_nc_ohc=89gBPt4zdQoQ7kNvwHjozP8&_nc_oc=AdqVhwUvGvEQIMiYGMGyEy3MmPYpIqXWXvJNGlazzWkGm7pmn1IvQbVNRGUYpOKlYRM&_nc_zt=23&_nc_ht=scontent-lga3-1.xx&edm=AAwGEdEEAAAA&_nc_gid=lKHHvS1bb3yYx6zcskmRdg&_nc_tpa=Q5bMBQK8QCCXHtV1p_P1uSvIaa0E-4twseDcHWSTQKM4wKRcTce9KBhsOTacQonXOkBpI9Uexib2ySQ7og&stp=c0.5000x0.5000f_dst-emg0_p600x600_q75_tt6&ur=a7ce7f&_nc_sid=58080a&oh=00_AQRadGdvGfWo04EzzqdS3cqSiuEPwbPcjf0Q7ha5FDOxOg&oe=6AF7742C",
  "120233817859220407": "https://scontent-lga3-2.xx.fbcdn.net/v/t15.5256-10/516240778_1757807591497235_9074676038521335514_n.jpg?_nc_cat=101&ccb=1-7&_nc_ohc=GMXViIvqbY0Q7kNvwEJiPbs&_nc_oc=Adp2BKnP5GLwY9LQleZw755EYee-jBPn3QDjO8tQZMr8bQThNpdas_50VrkPkAm1PN0&_nc_zt=23&_nc_ht=scontent-lga3-2.xx&edm=AAwGEdEEAAAA&_nc_gid=pV-B0_l4_hrFQBKjA-_XJA&_nc_tpa=Q5bMBQJbN_yQW8sEz1DmHuoWxqFs9RLbFKYWOyUIx3YZVMpRGy7oO_DDQWjcfxFL6gFx-WgbAZ1pByXGMQ&stp=c0.5000x0.5000f_dst-emg0_p600x600_q75_tt6&ur=d2b52d&_nc_sid=58080a&oh=00_AQQbEWq6QhtPKkEJtPSc51GLlbRfr5C3vBw9jZ6iPQpAsw&oe=6AF797D9",
  "120249989965590407": "https://scontent-lga3-2.xx.fbcdn.net/v/t15.5256-10/516240778_1757807591497235_9074676038521335514_n.jpg?_nc_cat=101&ccb=1-7&_nc_ohc=GMXViIvqbY0Q7kNvwEJiPbs&_nc_oc=Adp2BKnP5GLwY9LQleZw755EYee-jBPn3QDjO8tQZMr8bQThNpdas_50VrkPkAm1PN0&_nc_zt=23&_nc_ht=scontent-lga3-2.xx&edm=AAwGEdEEAAAA&_nc_gid=pxe67mjirfirzMsVvTJ5XQ&_nc_tpa=Q5bMBQILysbOUObOo4DapbzOvSYI-AloVpuixq0IoY5t9EOY3mBJKYqI0z0hsSYy7dv0BUARrhdgpXOHrg&stp=c0.5000x0.5000f_dst-emg0_p600x600_q75_tt6&ur=d2b52d&_nc_sid=58080a&oh=00_AQQwxJzOom5x_UKauSbbBdlXa75-RI6ice_yjafUHMB2Tg&oe=6AF797D9",
};
const REFERENCE_LOGO = process.env.REFERENCE_LOGO ?? "";

const jpeg = async (buf: Buffer) => `data:image/jpeg;base64,${(await sharp(buf).resize(160, 160, { fit: "cover" }).jpeg({ quality: 82 }).toBuffer()).toString("base64")}`;

/** A stand-in creative: a soft gradient with a shape, so a made-up ad has a picture */
async function drawn(seed: string) {
  const palettes: Record<string, [string, string, string]> = {
    coffee1: ["#3b2a20", "#c58b5a", "#f3e2cc"], coffee2: ["#e9dcc9", "#7a4b2a", "#2b1d14"], coffee3: ["#1f3b2d", "#b7d3b0", "#f6efe3"], coffee4: ["#5b3a29", "#e0b07a", "#2b2b2b"],
    tt1: ["#111111", "#ff3b5c", "#25f4ee"], tt2: ["#1b1b1b", "#d9a066", "#f6f1ea"], tt3: ["#202733", "#7fc8f8", "#ffe45e"],
    dent1: ["#e8f4f3", "#0f766e", "#ffffff"], dent2: ["#0f3d3a", "#5eead4", "#f0fdfa"], dent3: ["#f1f5f9", "#38bdf8", "#0f172a"],
    shrimp: ["#fde7dc", "#f08a5d", "#b83b5e"], box: ["#0e1c36", "#2785bb", "#e8f1f8"],
  };
  const [a, b, c] = palettes[seed] ?? ["#ddd", "#999", "#333"];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="320" height="320" fill="url(#g)"/><circle cx="210" cy="140" r="70" fill="${c}" fill-opacity="0.85"/><rect x="40" y="230" width="170" height="18" rx="9" fill="${c}" fill-opacity="0.9"/><rect x="40" y="258" width="110" height="12" rx="6" fill="${c}" fill-opacity="0.6"/></svg>`;
  return jpeg(await sharp(Buffer.from(svg)).png().toBuffer());
}

/** A drawn wordmark logo for a made-up client */
async function wordmark(name: string, color: string, mark: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="140"><circle cx="70" cy="70" r="52" fill="${color}"/><text x="70" y="88" font-family="Georgia, serif" font-size="52" font-weight="700" fill="#fff" text-anchor="middle">${mark}</text><text x="140" y="92" font-family="Georgia, serif" font-size="58" font-weight="700" fill="#1d1d1f">${name.replace(/&/g, "&amp;")}</text></svg>`;
  return processLogo(await sharp(Buffer.from(svg)).png().toBuffer());
}

async function imageFor(a: { id: string; image: string | null }) {
  const url = REAL_ADS[a.id] ?? a.image;
  if (!url) return null;
  if (url.startsWith("fixture:")) return drawn(url.slice(8));
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return res.ok ? jpeg(Buffer.from(await res.arrayBuffer())) : null;
  } catch {
    return null;
  }
}

async function websiteLogo(site: string) {
  try {
    const res = await fetch(site, { headers: { "user-agent": "Mozilla/5.0 (compatible; KaizenAds/1.0; report logo)" }, signal: AbortSignal.timeout(10000) });
    const html = await res.text();
    for (const c of logoCandidates(html, res.url || site).slice(0, 6)) {
      const url = c.replace(/^og:/, "");
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) }).catch(() => null);
      if (!r?.ok) continue;
      const got = await processLogo(Buffer.from(await r.arrayBuffer()));
      if (got) return { ...got, from: url };
    }
  } catch {
    // the site can't be reached from here
  }
  return null;
}

const part = (platform: ReportPart["platform"], metrics: ReportMetrics, extra: Partial<ReportPart> = {}): ReportPart => ({ platform, buyer: "Media buyer", metrics, sections: emptySections, extras: null, ...extra });

async function images(parts: ReportPart[]) {
  return Promise.all(parts.map((p) => (p.platform === "google" ? Promise.all((p.metrics.googleUnits ?? []).map((u) => (u.image ? drawn(u.image.slice(8)) : null))) : Promise.all(p.metrics.topAds.map(imageFor)))));
}

async function rasterize(pdf: Uint8Array, name: string) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  const fonts = `${path.resolve(__dirname, "../../node_modules/pdfjs-dist/standard_fonts").replace(/\\/g, "/")}/`;
  const doc = await pdfjs.getDocument({ data: pdf.slice(), standardFontDataUrl: fonts, useSystemFonts: false }).promise;
  const files: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
    const ctx = canvas.getContext("2d");
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;
    const file = path.join(OUT, `${name}-p${i}.png`);
    await fs.writeFile(file, canvas.toBuffer("image/png"));
    files.push(file);
  }
  return files;
}

async function sample(name: string, input: ReportPdfInput, pics: (string | null)[][]) {
  const pdf = new Uint8Array(await renderToBuffer(<ReportDocument input={input} images={pics} />));
  await fs.writeFile(path.join(OUT, `${name}.pdf`), pdf);
  const pngs = await rasterize(pdf, name);
  console.log(`${name}: ${pngs.length} page(s)`);
}

test("weekly report samples", async () => {
  await fs.mkdir(OUT, { recursive: true });
  const kaizen = `data:image/png;base64,${(await fs.readFile(path.resolve(__dirname, "../../public/kaizen-logo.png"))).toString("base64")}`;

  // OceanBox: the logo the report finds on oceanbox.com (else the reference report's copy), its colour from the logo
  let ocean = await websiteLogo("https://oceanbox.com/");
  console.log("OceanBox logo from", ocean?.from ?? "the reference copy", "colour", ocean?.color);
  if (!ocean && REFERENCE_LOGO) {
    const got = await processLogo(await fs.readFile(REFERENCE_LOGO));
    if (got) ocean = { ...got, from: "reference" };
  }
  const oceanBrand = { logo: ocean?.logo ?? null, light: ocean?.light ?? false, color: ocean?.color ?? null, agencyLogo: kaizen };

  const metaParts = [part("meta", oceanboxMeta)];
  await sample("oceanbox-meta-weekly", { client: "OceanBox", kind: "weekly", periodLabel: "Nov 2 – Nov 8", parts: metaParts, brand: oceanBrand }, await images(metaParts));
  const withNotes = [part("meta", oceanboxMeta, { sections: oceanboxMetaSections, layout: { notes: true } })];
  await sample("oceanbox-meta-weekly-with-notes", { client: "OceanBox", kind: "weekly", periodLabel: "Nov 2 – Nov 8", parts: withNotes, brand: oceanBrand }, await images(withNotes));
  const googleParts = [part("google", oceanboxGoogle)];
  await sample("oceanbox-google-weekly", { client: "OceanBox", kind: "weekly", periodLabel: "Nov 2 – Nov 8", parts: googleParts, brand: oceanBrand }, await images(googleParts));
  const unitParts = [part("google", googleWithUnits)];
  await sample("oceanbox-google-weekly-ad-groups", { client: "OceanBox", kind: "weekly", periodLabel: "Nov 2 – Nov 8", parts: unitParts, brand: oceanBrand }, await images(unitParts));

  const harbor = await wordmark("Harbor & Pine", "#b4532a", "H");
  const harborBrand = { logo: harbor?.logo ?? null, light: false, color: harbor?.color ?? null, agencyLogo: kaizen };
  const tt = [part("tiktok", harborTiktok)];
  await sample("harbor-tiktok-weekly", { client: "Harbor & Pine", kind: "weekly", periodLabel: "Nov 2 – Nov 8", parts: tt, brand: harborBrand }, await images(tt));
  const joint = [part("meta", harborMeta), part("tiktok", harborTiktok)];
  await sample("harbor-meta-tiktok-weekly", { client: "Harbor & Pine", kind: "weekly", periodLabel: "Nov 2 – Nov 8", parts: joint, brand: harborBrand }, await images(joint));

  // White label: the client's colour from their Brand Bible, no logo found (their name stands in), no Kaizen anywhere
  const wl = [part("meta", northsideMeta)];
  await sample("northside-white-label-weekly", { client: "Northside Dental", kind: "weekly", periodLabel: "Nov 2 – Nov 8", parts: wl, whiteLabel: true, brand: { logo: null, light: false, color: "#0f766e", agencyLogo: kaizen } }, await images(wl));
}, 180_000);
