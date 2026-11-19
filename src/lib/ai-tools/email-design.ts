import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import type { Staff } from "@/lib/auth";
import { askJson } from "@/lib/ai";
import { AI_BUCKET } from "@/lib/kaizen-ai/files";
import { channelMaySee } from "@/lib/kaizen-ai/channel-access";
import type { EmailDesignCard } from "@/lib/kaizen-ai/types";
import { bibleDesignNotes, checkEmail, designDigest, finishEmailHtml } from "@/lib/email-design/core";
import { hostImage, latestDesign, loadDesign, loadDesignHtml, saveVersion, type DesignMeta } from "@/lib/email-design/store";
import { previewSecret, previewToken } from "@/lib/email-design/token";
import { canGenerateMedia } from "@/lib/media-models";
import { isChannelOnly } from "@/lib/roles";
import { servicesOf } from "@/lib/services";
import { siteUrl } from "@/lib/site";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { str, type AiTool, type ChatExtra } from "./types";

// Kaizen AI's email design studio, for the email team (execs get it too). It turns copy into finished, production
// HTML emails on the client's brand (their Brand Bible, report logo and colour, and the look of what they've sent
// before), in one or several layouts at once, inspired by any newsletters attached as pictures; revises the last design
// in the thread ("make the hero bigger", "try a darker version"); and makes or edits pictures for the email with
// Higgsfield, placed into the design when they're ready. Each design shows on a card with desktop and mobile previews,
// dark mode, Copy HTML, Download and the steps to open it in Figma.

type ClientRow = { id: string; name: string };

const LAYOUT_PRESETS = [
  { name: "Hero first", direction: "A full-width hero picture or banner with the headline over or under it, one clear call to action high up, then short supporting sections." },
  { name: "Editorial", direction: "A magazine feel: a strong typographic headline, generous white space, a short story in two or three sections with pictures between them, one button at the end." },
  { name: "Product grid", direction: "Built to sell: a short headline band, then products or offers in a two-column grid (one column on phones), each with its own button, and a closing banner." },
];

const SYSTEM = `You are a senior email designer and developer at a performance marketing agency. You design and hand-code finished, production-ready marketing emails that look premium and convert.

Production rules (every email):
- Table-based layout, 600px wide, centred, with role="presentation" on layout tables, cellpadding/cellspacing 0 and border 0. No divs for layout (a div only for the hidden preheader).
- Every style the email needs to look right is inline on the element. One <style> block in the head is allowed only for what can't be inline: the phone layout (@media (max-width: 600px)), dark mode (@media (prefers-color-scheme: dark) plus [data-ogsc] / [data-ogsb] rules for Outlook.com), :hover, and web font imports.
- Mobile first: on phones columns stack (class-based media query rules with !important), text is at least 16px, buttons are at least 44px tall and full width, side padding is 20 to 24px.
- Bulletproof buttons: an <a> styled as a button inside a table cell with its own background colour, plus an <!--[if mso]> VML v:roundrect for Outlook. Never a picture of a button.
- Every <img> has alt text, a width attribute, display:block, border 0, and height:auto; the email still makes sense with images off (background colours behind the pictures, live text for every headline and offer).
- Dark mode safe: meta color-scheme and supported-color-schemes "light dark"; dark mode rules that keep the brand readable (no pure black on pure white flips that hide a logo); a logo that would vanish on dark gets a light chip or padding.
- A hidden preheader as the first thing in the body.
- Klaviyo-friendly: merge tags in Klaviyo's form ({{ first_name|default:'there' }}), {% unsubscribe %} and {% manage_preferences %} in the footer, the client's physical address placeholder {{ organization.full_address }} in the footer.
- Fonts: the brand's web font through a Google Fonts <link> only when it's on Google Fonts, always with a web-safe fallback stack (Arial, Helvetica, sans-serif or Georgia, serif).
- Keep the HTML lean (under 60 KB): no comments other than Outlook's, no repeated wrappers, no scripts, no forms, no external CSS.

Design standard: it must look like a top-tier brand's email, not a template. Clear hierarchy (one main message, one main action), confident type scale, real spacing rhythm, the brand's colours used with restraint, pictures where they earn their place. Use the copy you're given word for word where it's final; tighten only what's marked as a draft or obviously too long for the layout, and never invent offers, prices, dates or claims. Where a picture is needed but none is given, use a solid brand-colour block with live text instead of a placeholder service, and say so in your note. Use only the pictures and logo addresses given to you; never make up an image address.

Write plain words in your notes: no em dashes, no jargon, roles not people's names.`;

const SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "The layout's short name" },
    note: { type: "string", description: "Two or three plain sentences: the idea behind the design (or what changed), anything the team should add (a picture to swap in, a link to set)" },
    subject: { type: "string" },
    preheader: { type: "string" },
    html: { type: "string", description: "The whole email, from <!DOCTYPE html> to </html>" },
  },
  required: ["name", "note", "subject", "preheader", "html"],
  additionalProperties: false,
};

type Designed = { name: string; note: string; subject: string; preheader: string; html: string };

// ─── The client and what they look like ─────────────────────────────────────

async function clientFor(me: Staff, input: Record<string, unknown>, chat?: ChatExtra): Promise<ClientRow | null> {
  const db = await createClient();
  const asked = str(input.client);
  let row: ClientRow | null = null;
  if (asked) {
    const safe = asked.replace(/[%_,()]/g, " ").trim();
    const { data } = await db.from("clients").select("id, name, slug").or(`slug.eq.${safe.toLowerCase().replace(/\s+/g, "-")},name.ilike.%${safe}%`).limit(5);
    const exact = (data ?? []).find((c) => c.name.toLowerCase() === asked.toLowerCase() || c.slug === asked.toLowerCase());
    row = (exact ?? (data ?? [])[0] ?? null) as ClientRow | null;
    if (!row) throw new Error(`No client called "${asked}" that you can see.`);
  } else if (chat?.clientId) {
    const { data } = await db.from("clients").select("id, name").eq("id", chat.clientId).maybeSingle();
    row = (data as ClientRow | null) ?? null;
  }
  if (!row) return null;
  if (isChannelOnly(me.role)) {
    const admin = createAdminClient();
    const [{ data: c }, { data: seats }] = await Promise.all([
      admin.from("clients").select("archived_at, services, services_extra, services_removed, strategy_only").eq("id", row.id).maybeSingle(),
      admin.from("client_assignments").select("profile_id").eq("client_id", row.id),
    ]);
    if (!c || !channelMaySee({ id: me.id, role: me.role }, { archived: Boolean(c.archived_at), services: servicesOf(c), seatHolders: (seats ?? []).map((a) => String(a.profile_id)) })) throw new Error("You can't see this client.");
  }
  return row;
}

const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<null>((done) => setTimeout(() => done(null), ms))]);

/** A picture's shape, for the width and height the designer sets */
async function sizeOf(bytes: Buffer) {
  const m = await sharp(bytes)
    .metadata()
    .catch(() => null);
  return m?.width && m.height ? `${m.width}x${m.height}` : "unknown size";
}

/** The client's brand for the designer: logo (hosted with the design), colour, the Bible's look, and past emails */
async function brandContext(admin: SupabaseClient, client: ClientRow | null, designId: string, withPast: boolean) {
  if (!client) return { text: "No client is set: design it for a clean, neutral premium brand and say the brand should be set.", logo: null as string | null };
  const { reportBrand } = await import("@/lib/reports/brand-server");
  const [brand, { data: bible }, past] = await Promise.all([
    withTimeout(reportBrand(admin, client.id).catch(() => null), 25_000),
    admin.from("client_brand_bibles").select("markdown, read_this_first").eq("client_id", client.id).maybeSingle(),
    withPast ? pastEmails(admin, client.id) : Promise.resolve([]),
  ]);
  let logo: string | null = null;
  let logoSize = "";
  const m = brand?.logo?.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
  if (m) {
    const bytes = Buffer.from(m[2], "base64");
    logo = await hostImage(admin, designId, bytes, m[1], "logo").catch(() => null);
    logoSize = await sizeOf(bytes);
  }
  const b = bible as { markdown?: string | null; read_this_first?: string | null } | null;
  const parts = [
    `<client name="${client.name.replace(/"/g, "'")}">`,
    logo ? `Logo: ${logo} (${logoSize}${brand?.light ? ", a white logo: put it on a dark or brand-colour band" : ""}). Show it at 120 to 180px wide.` : "Logo: none found; set the brand name as a wordmark in the brand font.",
    brand?.color ? `Brand colour: ${brand.color}` : null,
    b?.read_this_first ? `<brand_bible_summary>\n${String(b.read_this_first).slice(0, 3000)}\n</brand_bible_summary>` : null,
    b?.markdown ? `<brand_bible_look note="the Brand Bible's colours, fonts, imagery and style; follow it">\n${bibleDesignNotes(b.markdown)}\n</brand_bible_look>` : null,
    past.length ? `<past_emails note="emails this client has sent (their best and latest); match their look and structure so the new one feels like theirs, while making it better">\n${past.join("\n\n")}\n</past_emails>` : null,
    "</client>",
  ];
  return { text: parts.filter(Boolean).join("\n"), logo };
}

/** The client's best and latest sent emails, each as a few lines on how it looks */
async function pastEmails(admin: SupabaseClient, clientId: string): Promise<string[]> {
  const base = () => admin.from("klaviyo_campaigns").select("campaign_id, name, subject, send_time, revenue, click_rate, channel").eq("client_id", clientId).not("send_time", "is", null).or("channel.is.null,channel.eq.email");
  const [{ data: best }, { data: latest }] = await Promise.all([base().order("revenue", { ascending: false, nullsFirst: false }).limit(2), base().order("send_time", { ascending: false }).limit(2)]);
  const picks = [...(best ?? []), ...(latest ?? [])].filter((c, i, all) => all.findIndex((x) => x.campaign_id === c.campaign_id) === i).slice(0, 3);
  if (!picks.length) return [];
  const { emailPreview } = await import("@/lib/email-providers");
  const out = await Promise.all(
    picks.map(async (c) => {
      const p = await withTimeout(emailPreview(admin, clientId, String(c.campaign_id)).catch(() => null), 12_000);
      if (!p?.ok || !p.preview.html) return null;
      const stats = [c.revenue ? `$${Math.round(Number(c.revenue)).toLocaleString("en-US")} revenue` : null, c.click_rate != null ? `${(Number(c.click_rate) * 100).toFixed(1)}% clicks` : null].filter(Boolean).join(", ");
      return `<past_email name="${String(c.name ?? "").replace(/"/g, "'")}" subject="${String(c.subject ?? "").replace(/"/g, "'")}" sent="${String(c.send_time).slice(0, 10)}"${stats ? ` results="${stats}"` : ""}>\n${designDigest(p.preview.html)}\n</past_email>`;
    }),
  );
  return out.filter((x): x is string => Boolean(x));
}

// ─── Pictures ───────────────────────────────────────────────────────────────

type Placed = { use: string; url: string; size: string; alt: string };
const IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

/**
 * The pictures to put in the email, each copied next to the design: an attached picture (by its name or number), a
 * finished Higgsfield picture ("job:<id>", the person's own), or a public https address.
 */
async function placeImages(admin: SupabaseClient, me: Staff, designId: string, raw: unknown, chat?: ChatExtra): Promise<{ placed: Placed[]; problems: string[] }> {
  const list = (Array.isArray(raw) ? raw : []).slice(0, 12) as { source?: unknown; use?: unknown; alt?: unknown }[];
  const placed: Placed[] = [];
  const problems: string[] = [];
  const pictures = (chat?.files ?? []).filter((f) => f.kind === "image");
  for (const it of list) {
    const source = String(it.source ?? "").trim();
    const use = String(it.use ?? "picture").slice(0, 60);
    const alt = String(it.alt ?? "").slice(0, 160);
    try {
      if (/^job:/i.test(source)) {
        const id = source.slice(4).trim();
        const { advance } = await import("@/lib/ai-media-jobs");
        await advance(admin, id).catch(() => null);
        const { data: job } = await admin.from("ai_media_jobs").select("profile_id, status, kind, result_paths").eq("id", id).maybeSingle();
        if (!job || (job.profile_id !== me.id && !me.isExec)) throw new Error(`no picture job ${id} of yours`);
        if (job.status !== "ready") throw new Error(`the picture (job ${id}) is still ${job.status}; place it when it's ready`);
        const file = ((job.result_paths ?? []) as { path: string; mime: string }[]).find((f) => f.mime?.startsWith("image/"));
        if (!file) throw new Error(`job ${id} made no picture`);
        const { MEDIA_BUCKET } = await import("@/lib/ai-media-jobs");
        const { data } = await admin.storage.from(MEDIA_BUCKET).download(file.path);
        if (!data) throw new Error(`the picture from job ${id} isn't there any more`);
        const bytes = Buffer.from(await data.arrayBuffer());
        placed.push({ use, alt, url: await hostImage(admin, designId, bytes, file.mime, use), size: await sizeOf(bytes) });
      } else if (/^https:\/\//i.test(source)) {
        const { isPublicHost } = await import("@/lib/references");
        if (!isPublicHost(source)) throw new Error(`${source} isn't a public address`);
        placed.push({ use, alt, url: source, size: "unknown size" });
      } else {
        const n = Number(source);
        const f = Number.isInteger(n) && n >= 1 && n <= pictures.length ? pictures[n - 1] : pictures.find((p) => p.name.toLowerCase() === source.toLowerCase());
        if (!f) throw new Error(`no attached picture called "${source}" on this message`);
        const { data } = await admin.storage.from(AI_BUCKET).download(f.path);
        if (!data) throw new Error(`${f.name} isn't there any more`);
        const bytes = Buffer.from(await data.arrayBuffer());
        placed.push({ use, alt, url: await hostImage(admin, designId, bytes, f.mime, use), size: await sizeOf(bytes) });
      }
    } catch (e) {
      problems.push(`${source || "(no source)"}: ${e instanceof Error ? e.message : "couldn't be placed"}`);
    }
  }
  return { placed, problems };
}

/** The attached pictures to look at as references (the ones not placed in the email itself), as the model sees them */
async function referenceImages(admin: SupabaseClient, chat: ChatExtra | undefined, names: unknown, placedNames: string[]) {
  const pictures = (chat?.files ?? []).filter((f) => f.kind === "image" && (IMAGE_MIMES as readonly string[]).includes(f.mime));
  const wanted = Array.isArray(names) && names.length ? names.map((x) => String(x).toLowerCase()) : null;
  const pick = pictures.filter((p, i) => (wanted ? wanted.includes(p.name.toLowerCase()) || wanted.includes(String(i + 1)) : !placedNames.includes(p.name.toLowerCase()))).slice(0, 6);
  const out: { mediaType: (typeof IMAGE_MIMES)[number]; data: string; name: string }[] = [];
  for (const p of pick) {
    const { data } = await admin.storage.from(AI_BUCKET).download(p.path);
    if (data) out.push({ mediaType: p.mime as (typeof IMAGE_MIMES)[number], data: Buffer.from(await data.arrayBuffer()).toString("base64"), name: p.name });
  }
  return out;
}

/** Whether the person has Figma connected in Kaizen AI */
async function figmaConnected(admin: SupabaseClient, me: Staff) {
  try {
    const { myConnections, offeredConnectors } = await import("@/lib/connectors/server");
    const [offered, mine] = await Promise.all([offeredConnectors(admin, me), myConnections(admin, me.id)]);
    const figma = offered.filter((c) => /figma/i.test(`${c.key} ${c.name}`)).map((c) => c.id);
    return mine.some((m) => figma.includes(m.connector_id) && m.status === "active");
  } catch {
    return false;
  }
}

// ─── The card ───────────────────────────────────────────────────────────────

function optionOf(meta: DesignMeta, html: string): EmailDesignCard["options"][number] {
  const v = meta.versions.at(-1)!;
  const secret = previewSecret();
  return {
    id: meta.id,
    version: v.n,
    name: v.name,
    note: v.note,
    subject: v.subject,
    preheader: v.preheader,
    checks: checkEmail(html),
    shareUrl: secret ? `${siteUrl()}/api/email-preview/${previewToken(secret, { id: meta.id, version: v.n })}` : null,
  };
}

const imageLines = (placed: Placed[], problems: string[]) =>
  [
    placed.length ? `<pictures note="put these in the email at these addresses; set width and height from their size">\n${placed.map((p) => `- ${p.use}: ${p.url} (${p.size})${p.alt ? `, alt: ${p.alt}` : ""}`).join("\n")}\n</pictures>` : null,
    problems.length ? `(Some pictures couldn't be placed, leave a brand-colour block where they'd go: ${problems.join("; ")})` : null,
  ]
    .filter(Boolean)
    .join("\n");

// ─── The tools ──────────────────────────────────────────────────────────────

const IMAGE_ITEMS = {
  type: "array",
  description: "Pictures to put in the email. source: an attached picture's file name or number, \"job:<id>\" for a finished Higgsfield picture (from email_design_image), or a public https address. use: where it goes (hero, product 1, lifestyle, banner, background). alt: its alt text.",
  items: { type: "object", properties: { source: { type: "string" }, use: { type: "string" }, alt: { type: "string" } }, required: ["source", "use"], additionalProperties: false },
};

export const tools: AiTool[] = [
  {
    name: "email_design",
    lines: ["email"],
    description:
      "Designs a finished, production-ready HTML email (table-based, inline CSS, 600px, mobile first, dark mode safe, bulletproof buttons, alt text, preheader, Klaviyo merge tags) from the copy, on the client's brand: their Brand Bible's colours and fonts, their logo, and the look of the emails they've sent before. Give the copy word for word (pasted, or the brief's copy). layouts: 1 for one design, 2 or 3 for different layout options of the same copy, side by side on the card. Attached newsletter screenshots are used as visual references (their layout, hierarchy and direction, never copied). If Figma is connected in this thread, read the client's Figma styles and components first and pass them in figma_styles. Shows a card with desktop and mobile previews, dark mode, Copy HTML, Download and Open in Figma. Takes a minute or two; say so before you call it.",
    input_schema: {
      type: "object",
      properties: {
        client: { type: "string", description: "The client's name. Leave out to use the client the thread is pinned to." },
        title: { type: "string", description: "A short name for the email (the campaign)" },
        copy: { type: "string", description: "The email's copy, word for word: headline, body, offers, button text, links, footer notes" },
        subject: { type: "string" },
        preheader: { type: "string" },
        direction: { type: "string", description: "What they asked for: the mood, what to feature, anything to match or avoid" },
        layouts: {
          type: "array",
          description: "1 to 3 layout directions to design, each its own option (name and a sentence on the layout). Leave out for one design in the best layout for the copy.",
          items: { type: "object", properties: { name: { type: "string" }, direction: { type: "string" } }, required: ["name"], additionalProperties: false },
          maxItems: 3,
        },
        images: IMAGE_ITEMS,
        reference_images: { type: "array", items: { type: "string" }, description: "Attached pictures to use as design references (names or numbers). Leave out to use every attached picture not placed in the email." },
        figma_styles: { type: "string", description: "The client's Figma styles and components read with the Figma connector (colours, type styles, button and card components), when it's connected" },
        use_past_emails: { type: "boolean", description: "Match the client's past emails (default true)" },
      },
      required: ["copy"],
      additionalProperties: false,
    },
    run: async (me, input, chat) => {
      const copy = str(input.copy);
      if (!copy) return { ok: false, error: "Give the email's copy (paste it, or the brief's copy)." };
      const admin = createAdminClient();
      const client = await clientFor(me, input, chat);
      const title = (str(input.title) ?? copy.split("\n")[0]).slice(0, 90);
      const asked = (Array.isArray(input.layouts) ? input.layouts : []).slice(0, 3) as { name?: string; direction?: string }[];
      const layouts = asked.length ? asked.map((l, i) => ({ name: String(l.name ?? LAYOUT_PRESETS[i].name).slice(0, 40), direction: String(l.direction ?? LAYOUT_PRESETS[i]?.direction ?? "") })) : [{ name: "", direction: "The layout that serves this copy best." }];
      const ids = layouts.map(() => crypto.randomUUID());
      const group = ids[0];
      const { placed, problems } = await placeImages(admin, me, group, input.images, chat);
      const placedNames = (Array.isArray(input.images) ? input.images : []).map((x) => String((x as { source?: unknown }).source ?? "").toLowerCase());
      const [brand, refs, figma] = await Promise.all([brandContext(admin, client, group, input.use_past_emails !== false), referenceImages(admin, chat, input.reference_images, placedNames), figmaConnected(admin, me)]);
      const shared = [
        brand.text,
        str(input.figma_styles) ? `<figma_styles note="the client's design system in Figma; use these colours, type styles and component looks">\n${String(input.figma_styles).slice(0, 8000)}\n</figma_styles>` : null,
        refs.length ? `<references>The ${refs.length} picture${refs.length > 1 ? "s" : ""} above (${refs.map((r) => r.name).join(", ")}) are examples to take inspiration from: their layout, hierarchy, spacing and visual direction. Don't copy them; make it the client's own.</references>` : null,
        imageLines(placed, problems),
        `<copy>\n${copy.slice(0, 12_000)}\n</copy>`,
        str(input.subject) ? `Subject line: ${input.subject}` : "Subject line: write one (under 45 characters) from the copy.",
        str(input.preheader) ? `Preheader: ${input.preheader}` : "Preheader: write one (40 to 90 characters) that adds to the subject.",
        str(input.direction) ? `What they asked for: ${input.direction}` : null,
      ]
        .filter(Boolean)
        .join("\n\n");
      const made = await Promise.all(
        layouts.map(async (l, i) => {
          try {
            const d = await askJson<Designed>({
              agent: "email_design_brief",
              label: "email design",
              clientId: client?.id ?? null,
              system: SYSTEM,
              prompt: `${shared}\n\n<layout>${l.name ? `${l.name}: ` : ""}${l.direction}</layout>\n\nDesign and code the email now. Return its layout name, your note, the subject, the preheader and the whole HTML.`,
              schema: SCHEMA,
              images: refs.map(({ mediaType, data }) => ({ mediaType, data })),
              maxTokens: 32_000,
            });
            const html = finishEmailHtml(d.html, { subject: d.subject, preheader: d.preheader });
            const meta: DesignMeta = { id: ids[i], owner: me.id, clientId: client?.id ?? null, clientName: client?.name ?? null, title, createdAt: new Date().toISOString(), group, versions: [{ n: 1, at: new Date().toISOString(), name: (l.name || d.name).slice(0, 40), note: d.note.slice(0, 600), subject: d.subject.slice(0, 150), preheader: d.preheader.slice(0, 200) }] };
            await saveVersion(admin, meta, html);
            return { meta, html };
          } catch (e) {
            return { error: `${l.name || "The design"}: ${e instanceof Error ? e.message : "couldn't be made"}` };
          }
        }),
      );
      const ok = made.filter((m): m is { meta: DesignMeta; html: string } => "meta" in m);
      const failed = made.filter((m): m is { error: string } => "error" in m).map((m) => m.error);
      if (!ok.length) return { ok: false, error: failed.join(" ") || "The design couldn't be made. Try again." };
      const options = ok.map((m) => optionOf(m.meta, m.html));
      chat?.card({ type: "email_design", client: client?.name ?? null, title, figma, options } satisfies EmailDesignCard);
      return {
        ok: true,
        designs: options.map((o) => ({ design_id: o.id, version: o.version, layout: o.name, note: o.note, subject: o.subject, preheader: o.preheader, to_fix: o.checks.filter((c) => !c.ok).map((c) => c.text) })),
        ...(failed.length ? { not_made: failed } : {}),
        ...(problems.length ? { pictures_not_placed: problems } : {}),
        note: "The card is on screen with the previews. In a line or two say what each option does differently and offer to revise one (email_design_revise with its design_id). Don't paste the HTML.",
      };
    },
  },
  {
    name: "email_design_revise",
    lines: ["email"],
    description:
      "Revises an email design made in this thread (\"make the hero bigger\", \"try a darker version\", \"swap in this picture\", \"shorter footer\") into a new version on a new card; earlier versions stay. design_id is from the email_design or email_design_revise result (or the card noted earlier in the thread); leave it out to revise the person's latest design. Pass images to place new pictures (an attached one, or a finished Higgsfield picture as job:<id>).",
    input_schema: {
      type: "object",
      properties: {
        design_id: { type: "string" },
        change: { type: "string", description: "What to change, in their words plus anything you know they mean" },
        images: IMAGE_ITEMS,
        reference_images: { type: "array", items: { type: "string" }, description: "Attached pictures to take direction from (names or numbers)" },
      },
      required: ["change"],
      additionalProperties: false,
    },
    run: async (me, input, chat) => {
      const change = str(input.change);
      if (!change) return { ok: false, error: "Say what to change." };
      const admin = createAdminClient();
      const id = str(input.design_id);
      const meta = id ? await loadDesign(admin, id) : await latestDesign(admin, me.id, chat?.clientId ?? null);
      if (!meta) return { ok: false, error: id ? "That design wasn't found." : "There's no design to revise yet: make one with email_design." };
      if (meta.owner !== me.id && !me.isExec) {
        const { mayOpenDesign } = await import("@/lib/email-design/store");
        if (!(await mayOpenDesign(me, meta, await createClient(), admin))) return { ok: false, error: "You can't open that design." };
      }
      const cur = meta.versions.at(-1)!;
      const html = await loadDesignHtml(admin, meta.id, cur.n);
      if (!html) return { ok: false, error: "The design's file isn't there any more." };
      const client = meta.clientId ? { id: meta.clientId, name: meta.clientName ?? "the client" } : null;
      const { placed, problems } = await placeImages(admin, me, meta.id, input.images, chat);
      const placedNames = (Array.isArray(input.images) ? input.images : []).map((x) => String((x as { source?: unknown }).source ?? "").toLowerCase());
      const [brand, refs, figma] = await Promise.all([brandContext(admin, client, meta.id, false), referenceImages(admin, chat, input.reference_images ?? [], placedNames), figmaConnected(admin, me)]);
      const d = await askJson<Designed>({
        agent: "email_design_brief",
        label: "email design revision",
        clientId: client?.id ?? null,
        system: SYSTEM,
        prompt: [
          brand.text,
          refs.length ? `<references>The picture${refs.length > 1 ? "s" : ""} above (${refs.map((r) => r.name).join(", ")}) show the direction they want.</references>` : null,
          imageLines(placed, problems),
          `<current_email subject="${(cur.subject ?? "").replace(/"/g, "'")}" preheader="${(cur.preheader ?? "").replace(/"/g, "'")}">\n${html}\n</current_email>`,
          `<change>${change}</change>`,
          "Make this change and keep everything else as it is (same copy, same structure) unless the change asks otherwise. Keep every production rule. Return the layout name, a note on what changed, the subject, the preheader and the whole new HTML.",
        ]
          .filter(Boolean)
          .join("\n\n"),
        schema: SCHEMA,
        images: refs.map(({ mediaType, data }) => ({ mediaType, data })),
        maxTokens: 32_000,
      });
      const next = finishEmailHtml(d.html, { subject: d.subject, preheader: d.preheader });
      meta.versions.push({ n: cur.n + 1, at: new Date().toISOString(), name: cur.name || d.name.slice(0, 40), note: d.note.slice(0, 600), subject: d.subject.slice(0, 150), preheader: d.preheader.slice(0, 200), ask: change.slice(0, 500) });
      await saveVersion(admin, meta, next);
      const option = optionOf(meta, next);
      chat?.card({ type: "email_design", client: meta.clientName, title: meta.title, figma, options: [option] } satisfies EmailDesignCard);
      return { ok: true, design_id: meta.id, version: option.version, note: option.note, to_fix: option.checks.filter((c) => !c.ok).map((c) => c.text), ...(problems.length ? { pictures_not_placed: problems } : {}), say: "The new version's card is on screen. Say what changed in a line." };
    },
  },
  {
    name: "email_design_image",
    lines: ["email"],
    spends: true,
    description:
      "Makes a picture for an email with Higgsfield: a product shot, a lifestyle visual, a banner or a background. With edit set to an attached picture, it edits that picture (the product photo stays the product; the scene, light or background change). It runs in the background (about a minute); then place it with email_design_revise (or email_design) images [{source: \"job:<id>\", use}]. Check on it with higgsfield_job.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What the picture shows, its light and mood, in the client's style; no text in the picture (the email's text stays live)" },
        use: { type: "string", enum: ["hero", "product", "lifestyle", "banner", "background"] },
        edit: { type: "string", description: "An attached picture to edit (its file name or number)" },
        aspect_ratio: { type: "string", enum: ["16:9", "4:3", "1:1", "3:4"], description: "Default by use: hero 4:3, banner 16:9, product 1:1, lifestyle 4:3, background 3:4" },
        client: { type: "string" },
      },
      required: ["prompt", "use"],
      additionalProperties: false,
    },
    run: async (me, input, chat) => {
      if (!canGenerateMedia(me)) return { ok: false, error: "Email designers and builders, the Head of Email, leads and execs can make pictures." };
      const { higgsfieldConfigured } = await import("@/lib/higgsfield");
      if (!higgsfieldConfigured()) return { ok: false, error: "Higgsfield isn't connected yet. An exec needs to add HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET in Vercel." };
      const admin = createAdminClient();
      const client = await clientFor(me, input, chat).catch(() => null);
      const use = String(input.use ?? "hero");
      const ratio = str(input.aspect_ratio) ?? ({ hero: "4:3", banner: "16:9", product: "1:1", lifestyle: "4:3", background: "3:4" } as Record<string, string>)[use] ?? "4:3";
      const { MEDIA_BUCKET, startGeneration } = await import("@/lib/ai-media-jobs");
      // Editing an attached picture: it goes to Higgsfield as the reference of the marketing image model
      let referencePath: string | null = null;
      const edit = str(input.edit);
      if (edit) {
        const pictures = (chat?.files ?? []).filter((f) => f.kind === "image");
        const n = Number(edit);
        const f = Number.isInteger(n) && n >= 1 && n <= pictures.length ? pictures[n - 1] : pictures.find((p) => p.name.toLowerCase() === edit.toLowerCase());
        if (!f) return { ok: false, error: `No attached picture called "${edit}" on this message. Ask them to attach it again.` };
        const { data } = await admin.storage.from(AI_BUCKET).download(f.path);
        if (!data) return { ok: false, error: `${f.name} isn't there any more.` };
        referencePath = `${client?.id ?? "team"}/refs/email-${crypto.randomUUID()}.${f.mime.split("/")[1]?.replace("jpeg", "jpg") ?? "png"}`;
        const up = await admin.storage.from(MEDIA_BUCKET).upload(referencePath, Buffer.from(await data.arrayBuffer()), { contentType: f.mime, upsert: false });
        if (up.error) return { ok: false, error: "The picture couldn't be sent to Higgsfield." };
      }
      // Products and edits: the marketing image model (it takes the product photo); people and places: Soul
      const model = referencePath || use === "product" || use === "banner" ? "marketing-image" : "soul-v2";
      const options = model === "marketing-image" ? { aspect_ratio: ratio, resolution: "2k" } : { aspect_ratio: ratio, resolution: "1080p" };
      const r = await startGeneration(admin, me, { model, prompt: String(input.prompt ?? "").slice(0, 2000), options, referencePath, clientId: client?.id ?? null, title: `Email ${use}${client ? ` for ${client.name}` : ""}` });
      if (!r.ok) return r;
      return { ok: true, job_id: r.id, model, say: `Started (${model === "marketing-image" ? "Higgsfield's marketing image model" : "Higgsfield Soul"}, ${ratio}). They'll get a notice when it's ready, in about a minute; then place it with images [{source: "job:${r.id}", use: "${use}"}].` };
    },
  },
];
