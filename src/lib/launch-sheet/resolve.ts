import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { metaConfigured, metaGraph } from "@/lib/context/meta";
import { assignUrl, metaWritableSetup, tokenScopes, writeBlocked } from "@/lib/meta-write";
import { cachedRead } from "@/lib/launch-cache";
import { copyWarnings } from "./payloads";
import { copyOf } from "./plan";
import { budgetSanity } from "./budget";
import type { CheckItem, ExistingMatch, LaunchSheet, ResolvedCreative, ResolvedFile, ResolvedGeo, ResolvedPost, Resolution } from "./types";

// Checking a launch sheet against the real ad account before anything is planned. Read-only: nothing is written to
// Meta or Drive here. Each check is a line the buyer sees with ✓ or ✗ and, when it fails, exactly what to do:
// - Pages: each Page the sheet names, found among the Pages the system user can advertise as (and its Instagram)
// - Creative: each Drive link opened (files and folders, "All Sizes" folders gone through), a 4:5 and a 9:16 picked
// - Existing posts: each Instagram or Facebook post link found as a post the ad account can run
// - Pixel: the dataset, and whether Purchase fired lately on the event link's site
// - The account: live writes, the token's permissions, campaigns and ad sets that already look like this event,
//   what they've spent against the sheet's numbers; dates in the past; policy (alcohol → 21+ in the US); copy limits

const norm = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
const DRIVE_ID = /(?:\/d\/|\/folders\/|[?&]id=)([\w-]{20,})/;

/** A file's shape from its pixels, else from its name ("4x5", "9:16", "1080x1350", "story", "feed") */
export function aspectOf(width: number | null, height: number | null, name: string): ResolvedFile["aspect"] {
  if (width && height) {
    const r = width / height;
    if (Math.abs(r - 0.8) < 0.03) return "4x5";
    if (Math.abs(r - 0.5625) < 0.03) return "9x16";
    if (Math.abs(r - 1) < 0.03) return "1x1";
    if (Math.abs(r - 1.7778) < 0.05) return "16x9";
    return "other";
  }
  const n = name.toLowerCase();
  if (/4\s*[x:×-]\s*5|1080\s*x\s*1350|feed|portrait/.test(n)) return "4x5";
  if (/9\s*[x:×-]\s*16|1080\s*x\s*1920|story|stories|reel|vertical/.test(n)) return "9x16";
  if (/1\s*[x:×-]\s*1|square|1080\s*x\s*1080/.test(n)) return "1x1";
  if (/16\s*[x:×-]\s*9|landscape|horizontal/.test(n)) return "16x9";
  return "other";
}

/** The 4:5 and 9:16 to run, and which sizes are missing (an older 1:1 is read, never launched) */
export function pickSizes(files: ResolvedFile[]): Pick<ResolvedCreative, "picked" | "missing"> {
  const media = files.filter((f) => f.kind === "image" || f.kind === "video").sort((a, b) => a.name.localeCompare(b.name));
  const feed = media.find((f) => f.aspect === "4x5") ?? null;
  // The vertical in the same kind as the feed one (a video's 9:16 with a video)
  const vertical = media.find((f) => f.aspect === "9x16" && (!feed || f.kind === feed.kind)) ?? null;
  const missing: ("4x5" | "9x16")[] = [];
  if (!feed) missing.push("4x5");
  if (!vertical) missing.push("9x16");
  return { picked: { feed: feed?.id ?? null, vertical: vertical?.id ?? null }, missing };
}

type DriveFile = { id: string; name: string; mimeType: string; size?: string; thumbnailLink?: string; imageMediaMetadata?: { width?: number; height?: number; rotation?: number }; videoMediaMetadata?: { width?: number; height?: number } };
const FIELDS = "id,name,mimeType,size,thumbnailLink,imageMediaMetadata(width,height,rotation),videoMediaMetadata(width,height)";

async function drive<T>(token: string, path: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}?${new URLSearchParams({ supportsAllDrives: "true", ...params })}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) throw new Error(res.status === 404 || res.status === 403 ? "Kaizen's Google account can't open it (share it with the agency, or anyone with the link)" : `Drive ${res.status}`);
  return res.json() as Promise<T>;
}

const asFile = (f: DriveFile): ResolvedFile | null => {
  const kind = f.mimeType.startsWith("image/") ? "image" : f.mimeType.startsWith("video/") ? "video" : null;
  if (!kind) return null;
  const meta = f.imageMediaMetadata ?? f.videoMediaMetadata;
  const rotated = (f.imageMediaMetadata?.rotation ?? 0) % 2 === 1;
  const w = meta?.width ?? null;
  const h = meta?.height ?? null;
  return { id: f.id, name: f.name, mime: f.mimeType, kind, width: rotated ? h : w, height: rotated ? w : h, aspect: aspectOf(rotated ? h : w, rotated ? w : h, f.name), thumb: f.thumbnailLink ?? null, bytes: f.size ? Number(f.size) : null };
};

/** Every image and video behind a Drive link: the file itself, or a folder's (two levels into subfolders) */
async function driveFiles(token: string, url: string): Promise<ResolvedFile[]> {
  const id = url.match(DRIVE_ID)?.[1];
  if (!id) return [];
  const f = await drive<DriveFile>(token, `files/${id}`, { fields: FIELDS });
  if (f.mimeType !== "application/vnd.google-apps.folder") {
    const one = asFile(f);
    return one ? [one] : [];
  }
  const out: ResolvedFile[] = [];
  const walk = async (folder: string, depth: number) => {
    const list = await drive<{ files: DriveFile[] }>(token, "files", { q: `'${folder}' in parents and trashed = false`, fields: `files(${FIELDS})`, pageSize: "200", includeItemsFromAllDrives: "true", corpora: "allDrives" });
    for (const x of list.files) {
      if (x.mimeType === "application/vnd.google-apps.folder") {
        if (depth < 2) await walk(x.id, depth + 1);
      } else {
        const r = asFile(x);
        if (r) out.push(r);
      }
    }
  };
  await walk(id, 0);
  return out;
}

/** The Pages the system user can advertise as, with their Instagram accounts */
async function usablePages(account: string) {
  type P = { id: string; name: string; tasks?: string[]; instagram_business_account?: { id: string; username?: string } };
  const [mine, promote, igs] = await Promise.all([
    metaGraph<{ data: P[] }>("me/accounts", { fields: "name,tasks,instagram_business_account{id,username}", limit: "200" }).catch(() => ({ data: [] as P[] })),
    metaGraph<{ data: P[] }>(`act_${account}/promote_pages`, { fields: "name,instagram_business_account{id,username}", limit: "200" }).catch(() => ({ data: [] as P[] })),
    metaGraph<{ data: { id: string; username?: string }[] }>(`act_${account}/instagram_accounts`, { fields: "username", limit: "100" }).catch(() => ({ data: [] })),
  ]);
  const all = new Map<string, P & { advertise: boolean; promotable: boolean }>();
  for (const p of mine.data) all.set(p.id, { ...p, advertise: (p.tasks ?? []).some((t) => ["ADVERTISE", "MANAGE", "CREATE_CONTENT"].includes(t)), promotable: false });
  for (const p of promote.data) {
    const cur = all.get(p.id);
    all.set(p.id, { ...(cur ?? p), ...p, advertise: cur?.advertise ?? true, promotable: true });
  }
  return { pages: [...all.values()], igs: igs.data };
}

/** The best Page for a name: exact, then one containing the other, then most words in common */
export function matchPage<T extends { name: string }>(name: string, pages: T[]): T | null {
  const n = norm(name);
  if (!n) return null;
  const exact = pages.find((p) => norm(p.name) === n);
  if (exact) return exact;
  const contains = pages.filter((p) => norm(p.name).includes(n) || n.includes(norm(p.name)));
  if (contains.length === 1) return contains[0];
  const words = new Set(n.split(" ").filter((w) => w.length > 2));
  let best: T | null = null;
  let score = 0;
  for (const p of contains.length ? contains : pages) {
    const s = norm(p.name)
      .split(" ")
      .filter((w) => words.has(w)).length;
    if (s > score) {
      score = s;
      best = p;
    }
  }
  return score >= Math.max(1, Math.ceil(words.size * 0.6)) ? best : null;
}

const shortcodeOf = (url: string) => url.match(/instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]+)/i)?.[1] ?? null;
const igUserOf = (url: string) => url.match(/instagram\.com\/([\w.]+)\/(?:p|reel|reels|tv)\//i)?.[1] ?? null;

/** An Instagram post's media id, found among the account's recent media (up to 500 back) */
async function igMedia(igId: string, shortcode: string): Promise<string | null> {
  let after: string | null = null;
  for (let i = 0; i < 5; i++) {
    const r: { data: { id: string; shortcode?: string; permalink?: string }[]; paging?: { cursors?: { after?: string }; next?: string } } = await metaGraph(`${igId}/media`, { fields: "shortcode,permalink", limit: "100", ...(after ? { after } : {}) });
    const hit = r.data.find((m) => m.shortcode === shortcode || (m.permalink ?? "").includes(`/${shortcode}`));
    if (hit) return hit.id;
    after = r.paging?.next ? (r.paging.cursors?.after ?? null) : null;
    if (!after) break;
  }
  return null;
}

const ALCOHOL = /\b(bar|bars|pub|crawl|brewery|beer|wine|cocktail|drinks?|liquor|spirits|happy hour|tequila|vodka|whiskey|bourbon|wristband)\b/i;
const SPECIAL = /\b(mortgage|apartment for rent|real estate|home loan|job opening|hiring|we're hiring|credit card|loan|insurance|election|vote for|ballot)\b/i;

export async function resolveSheet(admin: SupabaseClient, clientId: string, sheet: LaunchSheet, today: string): Promise<Resolution> {
  const checks: CheckItem[] = [];
  const add = (c: CheckItem) => checks.push(c);
  const { data: t } = await admin.from("kpi_targets").select("ad_account_id").eq("client_id", clientId).eq("platform", "meta").eq("active", true).not("ad_account_id", "is", null).order("created_at").limit(1).maybeSingle();
  const account = t?.ad_account_id ? String(t.ad_account_id).replace(/\D/g, "") : null;
  const res: Resolution = { account, pages: [], creatives: [], posts: [], geos: [], pixel: null, existing: [], spend: { matched: null, sheet: sheet.spentToDate }, checks, at: new Date().toISOString() };

  // ─── The account and Kaizen's access ─────────────────────────────────────────────────────────────────────
  if (!account) {
    add({ key: "account", label: "Ad account", level: "fail", detail: "No Meta ad account is linked to this client.", fix: "Link it on the KPI board (a Meta KPI with its ad account)." });
    return res;
  }
  if (!metaConfigured()) {
    add({ key: "account", label: "Meta connection", level: "fail", detail: "Meta isn't connected to Kaizen Ads.", fix: "Set META_SYSTEM_USER_TOKEN." });
    return res;
  }
  // Every part below is read at once (they don't depend on each other, except posts on the Pages); each keeps its own
  // checks, added in the usual order at the end. The account's Pages are kept ten minutes (src/lib/launch-cache.ts).
  const [blocked, scopes, { pages, igs }] = await Promise.all([
    writeBlocked(admin, account),
    tokenScopes().catch(() => ({ granted: [] as string[], missing: [] as string[] })),
    cachedRead(admin, `meta-pages:${account}`, () => usablePages(account), { clientId }).then((r) => r.value),
  ]);
  add(blocked ? { key: "live", label: "Live changes", level: "warn", detail: blocked, fix: "An exec switches live changes on for this client in Team & setup. Until then the plan can be checked and saved, not created." } : { key: "live", label: "Live changes", level: "ok", detail: "Kaizen can create in this ad account once you confirm." });
  if (scopes.missing.length) add({ key: "scopes", label: "Token permissions", level: "fail", detail: `The system user's token is missing ${scopes.missing.join(", ")}.`, fix: "Business settings → Users → System users → Generate new token with those permissions, then replace META_SYSTEM_USER_TOKEN." });

  // ─── Pages ──────────────────────────────────────────────────────────────────────────────────────────────
  const names = [...new Set(sheet.rows.map((r) => r.page.trim()).filter(Boolean))];
  for (const name of names) {
    const rows = sheet.rows.filter((r) => r.page.trim() === name).map((r) => r.index);
    const p = matchPage(name, pages);
    const ig = p?.instagram_business_account ?? null;
    const usable = Boolean(p && (p.advertise || p.promotable));
    res.pages.push({ name, pageId: p?.id ?? null, pageName: p?.name ?? null, igId: ig?.id ?? null, igName: ig?.username ?? null, canAdvertise: usable, how: p ? (p.promotable ? "in the ad account's Pages" : "assigned to the system user") : null, rows });
    if (!p)
      add({
        key: `page:${name}`,
        label: `Page "${name}"`,
        level: "fail",
        detail: `Kaizen can't find a Page called "${name}" that the system user can advertise as.`,
        fix: `Business settings → Accounts → Pages → Add → Request access to a Page (the Page's owner approves), then Assign people → the system user → Create ads. Or run these rows as partnership ads from the brand's Page. ${assignUrl(account)}`,
        rows,
      });
    else
      add({
        key: `page:${name}`,
        label: `Page "${name}"`,
        level: usable ? (ig ? "ok" : "warn") : "fail",
        detail: usable ? `Found as "${p.name}" (${p.id})${ig ? `, Instagram @${ig.username ?? ig.id}` : ", but no Instagram account is linked to it (the ads would run on Facebook only)"}.` : `"${p.name}" is visible but the system user can't create ads as it.`,
        fix: usable ? (ig ? null : "Link the Page's Instagram in Business settings → Accounts → Instagram accounts, and add it to the ad account.") : "Business settings → Pages → the Page → Assign people → the system user → Create ads.",
        rows,
      });
  }

  // ─── Creative files in Drive (every row at once; a link shared by rows is opened once) ─────────────────
  const creativesP = (async () => {
    const cs: CheckItem[] = [];
    let token: string | null = null;
    try {
      const { driveToken } = await import("@/lib/context/google");
      token = await driveToken();
    } catch {
      token = null;
    }
    const byLink = new Map<string, Promise<ResolvedFile[]>>();
    const made = await Promise.all(
      sheet.rows
        .filter((r) => !r.existingPost)
        .map(async (r): Promise<ResolvedCreative> => {
          const links = r.creative.links.filter((u) => /drive\.google\.com|docs\.google\.com/.test(u));
          if (!links.length) return { row: r.index, name: r.creative.name, files: [], picked: { feed: null, vertical: null }, missing: ["4x5", "9x16"], error: r.creative.name ? "No link to the files" : "No creative" };
          if (!token) return { row: r.index, name: r.creative.name, files: [], picked: { feed: null, vertical: null }, missing: ["4x5", "9x16"], error: "Google Drive isn't connected" };
          try {
            const files = (
              await Promise.all(
                links.map((u) => {
                  if (!byLink.has(u)) byLink.set(u, driveFiles(token!, u));
                  return byLink.get(u)!;
                }),
              )
            ).flat();
            return { row: r.index, name: r.creative.name, files, ...pickSizes(files), error: files.length ? null : "No images or videos in it" };
          } catch (e) {
            return { row: r.index, name: r.creative.name, files: [], picked: { feed: null, vertical: null }, missing: ["4x5", "9x16"], error: e instanceof Error ? e.message : String(e) };
          }
        }),
    );
    res.creatives.push(...made);
    const unread = res.creatives.filter((c) => c.error);
    const missingSize = res.creatives.filter((c) => !c.error && c.missing.length);
    const onlySquare = res.creatives.filter((c) => c.files.some((f) => f.aspect === "1x1") && c.missing.includes("4x5"));
    cs.push({
      key: "files",
      label: "Creative files",
      level: unread.length ? "fail" : missingSize.length ? "warn" : "ok",
      detail: unread.length
        ? `${unread.length} creative${unread.length === 1 ? "" : "s"} couldn't be read: ${unread.slice(0, 4).map((c) => `"${c.name}" (${c.error})`).join("; ")}.`
        : `${res.creatives.length} creative${res.creatives.length === 1 ? "" : "s"} opened in Drive.`,
      fix: unread.length ? "Share the Drive folders with the agency's Google Workspace (or anyone with the link), then check again." : null,
      rows: unread.map((c) => c.row),
    });
    if (missingSize.length)
      cs.push({
        key: "sizes",
        label: "Sizes (4:5 and 9:16)",
        level: "warn",
        detail: `${missingSize.length} creative${missingSize.length === 1 ? " is" : "s are"} missing a size: ${missingSize.slice(0, 5).map((c) => `"${c.name}" (no ${c.missing.join(" or ").replace(/x/g, ":")})`).join("; ")}.${onlySquare.length ? " Older 1:1 files are read but Kaizen launches 4:5 and 9:16." : ""}`,
        fix: "Ask the designer for the missing size, or run those with the one size they have.",
        rows: missingSize.map((c) => c.row),
      });
    else if (res.creatives.length && !unread.length) cs.push({ key: "sizes", label: "Sizes (4:5 and 9:16)", level: "ok", detail: "Every creative has a 4:5 and a 9:16." });
    return cs;
  })();

  // ─── Existing posts ────────────────────────────────────────────────────────────────────────────────────
  const postsP = (async () => {
    const cs: CheckItem[] = [];
    const found = await Promise.all(
      sheet.rows
        .filter((x) => x.existingPost)
        .map(async (r) => {
          const url = r.existingPost!;
          const post: ResolvedPost = { row: r.index, url, platform: /instagram/i.test(url) ? "instagram" : "facebook", shortcode: shortcodeOf(url), mediaId: null, igId: null, pageId: null, storyId: null, error: null };
          try {
            if (post.platform === "instagram") {
              const user = igUserOf(url)?.toLowerCase();
              const page = res.pages.find((p) => p.igName?.toLowerCase() === user) ?? res.pages.find((p) => p.name === r.page.trim());
              const ig = page?.igId ?? igs.find((i) => i.username?.toLowerCase() === user)?.id ?? null;
              post.igId = ig;
              post.pageId = page?.pageId ?? null;
              if (!ig || !post.shortcode) post.error = `The Instagram account${user ? ` @${user}` : ""} isn't one the ad account can use.`;
              else {
                post.mediaId = await igMedia(ig, post.shortcode);
                if (!post.mediaId) post.error = "Not found among the account's posts (deleted, a collab owned by another account, or older than the last 500).";
              }
            } else post.error = "Facebook post links are checked when the plan is built (the Page's post id).";
          } catch (e) {
            post.error = e instanceof Error ? e.message : String(e);
          }
          return post;
        }),
    );
    res.posts.push(...found);
    if (res.posts.length) {
      const bad = res.posts.filter((p) => p.error);
      cs.push({ key: "posts", label: "Existing posts", level: bad.length ? "fail" : "ok", detail: bad.length ? bad.map((p) => `${p.url}: ${p.error}`).join(" ") : `${res.posts.length} post${res.posts.length === 1 ? "" : "s"} found, ready to run as they are.`, fix: bad.length ? "Make sure the post is live on an Instagram account connected to the ad account; a shared or collab post may need its owner to allow ads (Partnership ad code)." : null, rows: bad.map((p) => p.row) });
    }
    return cs;
  })();

  // ─── Places as Meta locations (every place at once) ────────────────────────────────────────────────────
  const geosP = (async () => {
    const cs: CheckItem[] = [];
    const places = new Map<string, number[]>();
    for (const r of sheet.rows) if (r.geo.trim()) places.set(r.geo.trim(), [...(places.get(r.geo.trim()) ?? []), r.index]);
    if (!places.size && sheet.event.location) places.set(sheet.event.location, []);
    const geos = await Promise.all(
      [...places].map(async ([text, rows]) => {
        const g: ResolvedGeo = { text, key: null, name: null, type: null, region: null, country: null, rows };
        try {
          const r = await metaGraph<{ data: { key: string; name: string; type: string; region?: string; country_code?: string }[] }>("search", { type: "adgeolocation", q: text, location_types: JSON.stringify(["city", "region", "neighborhood", "zip", "country"]), limit: "5" });
          const hit = r.data.find((x) => x.type === "city" && x.country_code === "US") ?? r.data.find((x) => x.type === "city") ?? r.data[0];
          if (hit) Object.assign(g, { key: hit.key, name: hit.name, type: hit.type, region: hit.region ?? null, country: hit.country_code ?? null });
        } catch {
          // Left without a key: the plan says so
        }
        return g;
      }),
    );
    res.geos.push(...geos);
    const noGeo = res.geos.filter((g) => !g.key || g.type === "neighborhood");
    if (res.geos.length)
      cs.push({
        key: "geo",
        label: "Places",
        level: noGeo.length ? "warn" : "ok",
        detail: res.geos.map((g) => (g.key ? `"${g.text}" → ${g.name}${g.region ? `, ${g.region}` : ""} (${g.type})` : `"${g.text}" not found`)).join("; "),
        fix: noGeo.length ? "Say the city (and radius) to target for these." : null,
      });
    return cs;
  })();

  // ─── Pixel and Purchase ────────────────────────────────────────────────────────────────────────────────
  const pixelP = (async () => {
    const cs: CheckItem[] = [];
    try {
      const px = await metaGraph<{ data: { id: string; name: string; last_fired_time?: string; is_unavailable?: boolean }[] }>(`act_${account}/adspixels`, { fields: "name,last_fired_time,is_unavailable", limit: "50" });
      const live = px.data.filter((p) => !p.is_unavailable).sort((a, b) => (b.last_fired_time ?? "").localeCompare(a.last_fired_time ?? ""));
      const p = live[0];
      if (!p) cs.push({ key: "pixel", label: "Pixel", level: "fail", detail: "The ad account has no pixel (dataset).", fix: "Events Manager → connect a dataset to the website and share it with the ad account." });
      else {
        const since = String(Math.floor(Date.now() / 1000) - 7 * 86400);
        const [events, hosts] = await Promise.all([
          metaGraph<{ data: { data?: { value: string; count: number }[] }[] }>(`${p.id}/stats`, { aggregation: "event", start_time: since }).catch(() => null),
          metaGraph<{ data: { data?: { value: string; count: number }[] }[] }>(`${p.id}/stats`, { aggregation: "host", start_time: since }).catch(() => null),
        ]);
        const ev = events?.data.flatMap((d) => d.data ?? []) ?? [];
        const purchase = events ? ev.some((e) => /^purchase$/i.test(e.value) && e.count > 0) : null;
        const host = sheet.event.link ? new URL(sheet.event.link).hostname.replace(/^www\./, "") : null;
        const hs = hosts?.data.flatMap((d) => d.data ?? []).map((h) => h.value.replace(/^www\./, "")) ?? [];
        const domainSeen = hosts && host ? hs.some((h) => h === host || h.endsWith(`.${host}`) || host.endsWith(`.${h}`)) : null;
        res.pixel = { id: p.id, name: p.name, lastFired: p.last_fired_time ?? null, purchaseRecent: purchase, domainSeen };
        const ok = purchase !== false && domainSeen !== false;
        cs.push({
          key: "pixel",
          label: "Pixel and Purchase",
          level: ok ? (purchase == null ? "warn" : "ok") : "fail",
          detail: `${p.name} (${p.id}), last fired ${p.last_fired_time ? p.last_fired_time.slice(0, 10) : "never"}. ${purchase == null ? "Couldn't read its events." : purchase ? "Purchase fired in the last 7 days." : "No Purchase in the last 7 days."}${host ? ` ${domainSeen == null ? "" : domainSeen ? `Seen on ${host}.` : `Not seen on ${host} lately.`}` : ""}`,
          fix: ok ? null : "Check the ticket checkout fires Purchase to this dataset (Events Manager → Test events) before optimizing for purchases.",
        });
      }
    } catch (e) {
      cs.push({ key: "pixel", label: "Pixel", level: "warn", detail: `Couldn't read the pixels: ${e instanceof Error ? e.message : String(e)}` });
    }
    return cs;
  })();

  // ─── What's already in the account, and its spend ──────────────────────────────────────────────────────
  const existingP = (async () => {
    const cs: CheckItem[] = [];
    try {
      const setup = await metaWritableSetup(admin, account);
      const words = norm(`${sheet.event.name} ${sheet.event.location}`)
        .split(" ")
        .filter((w) => w.length > 3 && !["fest", "the", "with", "event"].includes(w));
      const hit = (name: string) => {
        const n = norm(name);
        return words.length > 0 && words.filter((w) => n.includes(w)).length >= Math.min(2, words.length);
      };
      const matches: ExistingMatch[] = [
        ...setup.campaigns.filter((c) => hit(c.name)).map((c) => ({ level: "campaign" as const, id: c.id, name: c.name, status: c.effective, dailyBudget: c.dailyBudget, lifetimeBudget: c.lifetimeBudget, spend: null })),
        ...setup.adsets.filter((s) => hit(s.name) || hit(s.campaign)).map((s) => ({ level: "adset" as const, id: s.id, name: s.name, status: s.effective, campaignId: s.campaignId, dailyBudget: s.dailyBudget, lifetimeBudget: s.lifetimeBudget, spend: null })),
      ].slice(0, 20);
      // Each matching campaign's lifetime spend, all at once
      await Promise.all(
        matches
          .filter((x) => x.level === "campaign")
          .map(async (m) => {
            const r = await metaGraph<{ data: { spend?: string }[] }>(`${m.id}/insights`, { fields: "spend", date_preset: "maximum" }).catch(() => ({ data: [] }));
            m.spend = Math.round(Number(r.data[0]?.spend ?? 0) * 100) / 100;
          }),
      );
      const spent = matches.filter((x) => x.level === "campaign").reduce((s, m) => s + (m.spend ?? 0), 0);
      // Nothing named like the event: the live campaigns and ad sets spending most are still offered, to add to or copy
      const spend14 = new Map<string, number>();
      for (const a of setup.ads) spend14.set(a.adsetId, (spend14.get(a.adsetId) ?? 0) + a.spend14);
      const related: ExistingMatch[] = matches.length
        ? []
        : setup.adsets
            .filter((s) => s.effective === "ACTIVE")
            .sort((a, b) => (spend14.get(b.id) ?? 0) - (spend14.get(a.id) ?? 0))
            .slice(0, 3)
            .flatMap((s) => {
              const c = setup.campaigns.find((x) => x.id === s.campaignId);
              return [
                ...(c ? [{ level: "campaign" as const, id: c.id, name: c.name, status: c.effective, dailyBudget: c.dailyBudget, lifetimeBudget: c.lifetimeBudget, spend: null, related: true }] : []),
                { level: "adset" as const, id: s.id, name: s.name, status: s.effective, campaignId: s.campaignId, dailyBudget: s.dailyBudget, lifetimeBudget: s.lifetimeBudget, spend: Math.round((spend14.get(s.id) ?? 0) * 100) / 100, related: true },
              ];
            })
            .filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i);
      res.existing = [...matches, ...related];
      res.spend.matched = matches.some((m) => m.level === "campaign") ? Math.round(spent * 100) / 100 : null;
      cs.push({
        key: "existing",
        label: "Already in the account",
        level: matches.length ? "warn" : "ok",
        detail: matches.length ? `${matches.filter((m) => m.level === "campaign").length} campaign(s) and ${matches.filter((m) => m.level === "adset").length} ad set(s) look like this event: ${matches.slice(0, 4).map((m) => `"${m.name}" (${m.status.toLowerCase().replace(/_/g, " ")})`).join(", ")}. New ads can go into them instead of duplicating.` : "Nothing in the account looks like this event: it would be new.",
      });
      if (res.spend.matched != null)
        cs.push({
          key: "spend",
          label: "Spend to date",
          level: sheet.spentToDate != null && Math.abs(res.spend.matched - sheet.spentToDate) > Math.max(50, sheet.spentToDate * 0.1) ? "warn" : "info",
          detail: `Those campaigns have spent $${res.spend.matched.toFixed(2)} in total${sheet.spentToDate != null ? `; the sheet says $${sheet.spentToDate.toFixed(2)}${sheet.spentThrough ? ` through ${sheet.spentThrough}` : ""}` : ""}${sheet.totalBudget != null ? ` of a $${sheet.totalBudget.toFixed(2)} total` : ""}.`,
        });
    } catch (e) {
      cs.push({ key: "existing", label: "Already in the account", level: "warn", detail: `Couldn't read the account: ${e instanceof Error ? e.message : String(e)}` });
    }
    return cs;
  })();

  for (const part of await Promise.all([creativesP, postsP, geosP, pixelP, existingP])) for (const c of part) add(c);

  // ─── Dates, budget math, policy, copy ──────────────────────────────────────────────────────────────────
  const past = sheet.rows.filter((r) => r.date && r.date < today);
  if (sheet.event.date && sheet.event.date < today) add({ key: "dates", label: "Dates", level: "fail", detail: `The event (${sheet.event.date}) is already over.`, rows: past.map((r) => r.index) });
  else if (past.length) add({ key: "dates", label: "Dates", level: "warn", detail: `${past.length} row${past.length === 1 ? " is" : "s are"} dated before today (${today}): they'd start when turned on, or they were launched already.`, rows: past.map((r) => r.index) });
  else add({ key: "dates", label: "Dates", level: "ok", detail: "Every row is dated today or later." });
  const tier = sheet.budgets.find((b) => /meta|facebook|instagram/i.test(b.platform)) ?? sheet.budgets[0];
  if (tier) {
    const sanity = budgetSanity(sheet.totalBudget, sheet.spentToDate, tier.periods);
    add({ key: "budget", label: "Budget math", level: sanity.length ? "warn" : "ok", detail: sanity.length ? sanity.join(" ") : `The ${tier.platform} periods add up with the sheet's total and spend. They're totals per period, never copied in as daily budgets.` });
  }
  const text = [sheet.event.name, sheet.goal, ...sheet.rows.flatMap((r) => r.copy.flatMap((c) => [c.headline, c.primary]))].join(" ");
  if (ALCOHOL.test(text)) add({ key: "policy_alcohol", label: "Alcohol policy", level: "info", detail: "The ads promote bars or drinks: Meta requires ages 21+ in the US (18+ or local drinking age elsewhere).", fix: "Kaizen sets the minimum age to 21 for US targeting." });
  if (SPECIAL.test(text)) add({ key: "policy_special", label: "Special ad category", level: "warn", detail: "The copy reads like housing, employment, credit or politics, which needs a special ad category.", fix: "Confirm whether a special ad category applies." });
  const long = sheet.rows.flatMap((r) => copyWarnings({ copy: copyOf(sheet, [r.index]) } as Parameters<typeof copyWarnings>[0]).map((w) => ({ row: r.index, w })));
  add(long.length ? { key: "copy", label: "Copy limits", level: "warn", detail: [...new Set(long.map((l) => l.w))].slice(0, 4).join(" "), rows: [...new Set(long.map((l) => l.row))] } : { key: "copy", label: "Copy limits", level: "ok", detail: "Every text option is within Meta's limits." });
  return res;
}
