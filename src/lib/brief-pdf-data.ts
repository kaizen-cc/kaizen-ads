import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AiUnavailable, aiEnabled, askJson } from "@/lib/ai";
import { STRUCTURE_SCHEMA, fitStructure, plainStructure, slidesFor, versionCount, type BriefStructure, type StructureSource } from "@/lib/brief-pdf-model";
import type { PdfReference } from "@/lib/brief-pdf";
import { attachLinks } from "@/lib/asset-links";
import { BRIEF_BUCKET, parseBriefFileUrl } from "@/lib/brief-files";
import { parseBrief } from "@/lib/brief-spec";

// What the brief PDF reads on the server: the brief restructured into a production sheet (one fast AI pass, cached on
// the draft by the caller), and the pictures of what the request is built on (a market ad, a winner, a saved idea),
// fetched here and made small JPEGs, each with its links.

/** One fast pass that restructures the brief into the sheet's fields. Never invents: what the brief doesn't say stays empty. */
export async function structureBrief(d: StructureSource & { clientId: string; client: string }): Promise<BriefStructure> {
  // Every asset keeps the Drive link the brief gave it (the AI's shorter lines get theirs back from the brief's own)
  const linked = (s: BriefStructure): BriefStructure => {
    try {
      return { ...s, assets: attachLinks(s.assets, parseBrief(d.brief ?? "").spec.assets) };
    } catch {
      return s;
    }
  };
  if (!aiEnabled()) return linked(plainStructure(d));
  const n = Math.max(1, versionCount(d.formats));
  const cards = slidesFor(d.formats);
  try {
    const out = await askJson<Partial<BriefStructure>>({
      agent: "strategist",
      label: "brief pdf structure",
      clientId: d.clientId,
      override: { model: "sonnet", effort: "low" },
      maxTokens: 6000,
      schema: STRUCTURE_SCHEMA as unknown as Record<string, unknown>,
      system:
        "You turn a written creative brief into a one-page production sheet that the designer or video editor reads at a glance: precise on what and why, the how (style, pacing, music, edit structure) left to them. You restructure, you don't write a new brief: use the brief's own ideas and words, tightened. Never invent offers, prices, numbers, claims, testimonials, product names or rules the brief doesn't state; when the brief doesn't say something, leave that field empty. Plain words, short lines, no em dashes, no hype.",
      prompt: [
        `Client: ${d.client}`,
        `Title: ${d.title || "(none)"}`,
        `Angle: ${d.angle || "(none)"}`,
        `Audience: ${d.audience || "(none)"}`,
        `Landing page: ${d.landing || "(none)"}`,
        `What gets made: 1 concept, ${n} version${n === 1 ? "" : "s"}${cards ? `, a carousel of ${cards} slides per version` : ""}`,
        "",
        "The brief as written:",
        d.brief || "(empty)",
        "",
        "Fill in:",
        "- oneLine: the idea in one line (under 20 words).",
        "- summary: 3 to 5 bullets, each under 25 words: what we're making, who it's for, why it should work, what to avoid. Skip a point the brief doesn't support.",
        `- versions: exactly ${n} rows, V1 first. headline = the on-image text (or the video's opening line), subline = the supporting line under it, visual = what must be in the frame (the subject, the product, the proof), never how to shoot, pace or edit it (that's the maker's call), hook = what stops the scroll. Versions differ the way the brief says they should (hooks, headlines, visuals); when the brief only names V1, later rows are variations of V1 that change one thing the brief suggests, and their fields may stay empty rather than be made up.`,
        cards ? `- slides: exactly ${cards} rows in order, what each slide says (headline, subline) and shows (visual).` : "- slides: an empty list (not a carousel).",
        "- dos and donts: the brand rules, compliance points and things the client rejected that the brief states, each under 18 words.",
        "- copy: primary text, headlines and the call to action only when the brief gives them (empty otherwise).",
        "- assets: what it's made from (footage, photos, logos on Drive) and what to get from the client, when the brief says. Keep each asset's link at the end of its line exactly as the brief has it.",
      ].join("\n"),
    });
    return linked(fitStructure(out, d, true));
  } catch (e) {
    if (!(e instanceof AiUnavailable)) console.error("[brief-pdf] structure", e instanceof Error ? e.message : e);
    return linked(plainStructure(d));
  }
}

// ─── The pictures of what it's built on ─────────────────────────────────────────

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;

/** A picture from the web, made a small JPEG the PDF can embed (webp, png, gif all read) */
async function fetchPicture(url: string): Promise<Buffer | null> {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || PRIVATE_HOST.test(u.hostname)) return null;
    const res = await fetch(u, { cache: "no-store", signal: AbortSignal.timeout(7000) });
    if (!res.ok || !(res.headers.get("content-type") ?? "image/").startsWith("image/")) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length > 300 && bytes.length < 15_000_000 ? await toJpeg(bytes) : null;
  } catch {
    return null;
  }
}

export async function toJpeg(bytes: Uint8Array): Promise<Buffer | null> {
  try {
    const sharp = (await import("sharp")).default;
    return await sharp(bytes, { animated: false }).rotate().resize({ width: 720, height: 1280, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 78 }).toBuffer();
  } catch {
    return null;
  }
}

async function adPicture(admin: SupabaseClient | null, adId: string, fallback?: string | null) {
  if (admin) {
    const { readAdMedia } = await import("@/lib/ad-media");
    const m = await readAdMedia(admin, adId).catch(() => null);
    if (m) {
      const j = await toJpeg(m.bytes);
      if (j) return j;
    }
  }
  return fallback ? fetchPicture(fallback) : null;
}

export type RefInput = {
  origin: { kind?: string; label?: string; link?: string | null; thumb?: string | null; suggestionId?: string | null } | null;
  savedRefIds: string[];
  refs: string[];
  /** The app's address, for links back into Kaizen Ads */
  appOrigin: string;
};

type Draft = Omit<PdfReference, "image"> & { key: string; picture: () => Promise<Buffer | null> };

const abs = (u: string | null | undefined, base: string) => {
  if (!u) return null;
  try {
    const x = new URL(u, base);
    return /^https?:$/.test(x.protocol) ? x.href : null;
  } catch {
    return null;
  }
};

/**
 * The references with pictures: the idea it's built on first (a market ad with its Ad Library, Motion and landing page
 * links; a winner; a saved idea), then saved references and reference links that point at an ad. At most six. Links
 * that aren't ads come back separately, to list.
 */
export async function gatherReferences(db: SupabaseClient, admin: SupabaseClient | null, input: RefInput): Promise<{ refs: PdfReference[]; links: { label: string; url: string }[] }> {
  const read = admin ?? db;
  const out: Draft[] = [];
  const seen = new Set<string>();
  const add = (d: Draft) => {
    if (seen.has(d.key) || out.length >= 6) return;
    seen.add(d.key);
    out.push(d);
  };
  const { loadMarketAd } = await import("@/lib/market");
  const market = async (id: string, kicker: string, note?: string | null) => {
    if (seen.has(`market:${id}`)) return true;
    const a = await loadMarketAd(read, id).catch(() => null);
    if (!a) return false;
    const video = a.media[0]?.type === "video";
    const still = a.media.find((m) => m.type === "image")?.url ?? a.media[0]?.thumb ?? null;
    add({
      key: `market:${id}`,
      kicker,
      title: a.headline ?? a.angle ?? "A live ad in the market",
      brand: a.brand,
      days: a.daysActive,
      video,
      note: note ?? a.why ?? a.hook ?? null,
      links: [
        ...(a.libraryUrl ? [{ label: "Meta Ad Library", url: a.libraryUrl }] : []),
        ...(a.motionUrl ? [{ label: "Motion", url: a.motionUrl }] : []),
        ...(a.landingUrl ? [{ label: "Their landing page", url: a.landingUrl }] : []),
      ],
      picture: () => (still ? fetchPicture(still) : Promise.resolve(null)),
    });
    return true;
  };
  const winner = (adId: string, kicker: string, title: string, brand: string | null, thumb: string | null) =>
    add({
      key: `ad:${adId}`,
      kicker,
      title,
      brand,
      days: null,
      video: false,
      note: null,
      links: [{ label: "Open in Kaizen Ads", url: abs(`/winners?ad=${encodeURIComponent(adId)}`, input.appOrigin)! }],
      picture: () => adPicture(admin, adId, thumb && /^https?:/.test(thumb) ? thumb : null),
    });

  // 1. The idea it's built on
  const o = input.origin;
  if (o) {
    let done = false;
    if (o.suggestionId && /^[0-9a-f-]{36}$/i.test(o.suggestionId)) {
      const { data: s } = await read.from("creative_suggestions").select("kind, source").eq("id", o.suggestionId).maybeSingle();
      const src = (s?.source ?? {}) as { marketAdId?: string; adId?: string; thumbnail?: string | null; headline?: string | null; client?: string | null; fatigue?: boolean };
      if (src.marketAdId) done = await market(src.marketAdId, "Built on a live ad in the market");
      else if (src.adId && /^\d{5,25}$/.test(src.adId)) {
        winner(src.adId, src.fatigue ? "The ad it refreshes" : "Built on a winning ad", src.headline ?? o.label ?? "A winning ad", src.client && src.client !== "this account" ? src.client : null, src.thumbnail ?? null);
        done = true;
      }
    }
    if (!done) {
      const adId = /\/api\/ad-media\/(\d{5,25})/.exec(o.thumb ?? "")?.[1];
      const link = abs(o.link, input.appOrigin);
      if (adId) winner(adId, "Built on", o.label ?? "The original ad", null, null);
      else if (o.thumb && /^https?:/.test(o.thumb))
        add({ key: `origin:${o.thumb}`, kicker: "Built on", title: o.label ?? "The idea it's built on", brand: null, days: null, video: false, note: null, links: link ? [{ label: "The original", url: link }] : [], picture: () => fetchPicture(o.thumb!) });
    }
  }

  // 2. Saved references the request goes with
  const ids = input.savedRefIds.filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 8);
  if (ids.length) {
    const { data: rows } = await db.from("client_saved_references").select("id, source, ref_id, url, thumbnail, title, subtitle, format, data").in("id", ids);
    for (const r of rows ?? []) {
      const data = (r.data ?? {}) as { video?: string | null; days?: number | null };
      if (r.source === "market" && (await market(r.ref_id as string, "Saved reference"))) continue;
      if (r.source === "winner" && /^\d{5,25}$/.test(r.ref_id as string)) {
        winner(r.ref_id as string, "Saved winner", (r.title as string | null) ?? "A winning ad", (r.subtitle as string | null) ?? null, (r.thumbnail as string | null) ?? null);
        continue;
      }
      const url = abs(r.url as string | null, input.appOrigin);
      const thumb = r.thumbnail as string | null;
      add({
        key: `saved:${r.id}`,
        kicker: "Saved reference",
        title: (r.title as string | null) ?? "A saved idea",
        brand: (r.subtitle as string | null) ?? null,
        days: typeof data.days === "number" ? data.days : null,
        video: Boolean(data.video) || r.format === "video",
        note: null,
        links: url ? [{ label: "Open the reference", url }] : [],
        picture: async () => {
          const ad = /\/api\/ad-media\/(\d{5,25})/.exec(thumb ?? "")?.[1];
          if (ad) return adPicture(admin, ad);
          return thumb && /^https?:/.test(thumb) ? fetchPicture(thumb) : null;
        },
      });
    }
  }

  // 3. Reference links: ones that point at an ad get their picture, the rest are listed
  const links: { label: string; url: string }[] = [];
  for (const raw of input.refs) {
    const u = abs(raw, input.appOrigin);
    if (!u) continue;
    // A file added to the brief: its picture (a video's first frame) read from storage, and its link
    const file = parseBriefFileUrl(u);
    if (file) {
      const pic = file.kind === "image" ? file.path : file.kind === "video" ? file.thumb : null;
      if (pic && admin && out.length < 6) {
        add({
          key: `file:${file.path}`,
          kicker: file.kind === "video" ? "Added video" : "Added picture",
          title: file.name,
          brand: null,
          days: null,
          video: file.kind === "video",
          note: null,
          links: [{ label: "Open the file", url: u }],
          picture: async () => {
            const { data } = await admin.storage.from(BRIEF_BUCKET).download(pic);
            return data ? toJpeg(new Uint8Array(await data.arrayBuffer())) : null;
          },
        });
      } else links.push({ label: `Added ${file.kind === "pdf" ? "PDF" : file.kind}: ${file.name}`, url: u });
      continue;
    }
    const x = new URL(u);
    const mine = x.origin === new URL(input.appOrigin).origin;
    const ad = /\/api\/ad-media\/(\d{5,25})/.exec(x.pathname)?.[1] ?? (mine && x.pathname === "/winners" ? x.searchParams.get("ad") : null);
    const marketId = mine && x.pathname === "/market" ? x.searchParams.get("ad") : null;
    if (marketId && (await market(marketId, "Reference"))) continue;
    if (ad && /^\d{5,25}$/.test(ad)) {
      winner(ad, "Reference", "A reference ad", null, null);
      continue;
    }
    if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(x.pathname) && out.length < 6) {
      add({ key: `img:${u}`, kicker: "Reference", title: x.hostname.replace(/^www\./, ""), brand: null, days: null, video: false, note: null, links: [{ label: "Open the picture", url: u }], picture: () => fetchPicture(u) });
      continue;
    }
    links.push({ label: linkLabel(x), url: u });
  }

  const pictures = await Promise.all(out.map((d) => d.picture().catch(() => null)));
  const refs = out.map((d, i): PdfReference => ({ kicker: d.kicker, title: d.title, brand: d.brand, days: d.days, video: d.video, note: d.note, links: d.links, image: pictures[i] }));
  return { refs, links };
}

/** "Motion", "Meta Ad Library", "Google Drive" or the site's name */
export function linkLabel(x: URL) {
  const h = x.hostname.replace(/^www\./, "");
  if (/motionapp|motion\.app/.test(h)) return "Motion";
  if (/facebook\.com$/.test(h) && x.pathname.startsWith("/ads/library")) return "Meta Ad Library";
  if (/drive\.google\.com|docs\.google\.com/.test(h)) return "Google Drive";
  if (/loom\.com$/.test(h)) return "Loom";
  if (/frame\.io$/.test(h)) return "Frame.io";
  if (/instagram\.com$/.test(h)) return "Instagram";
  if (/tiktok\.com$/.test(h)) return "TikTok";
  return h;
}
