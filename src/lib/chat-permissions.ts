// What each person may DO from the chat (the client page's chat, the KPI board's chat, Kaizen AI) and the server
// actions behind it, in one place. Asking questions and reading numbers stays open to everyone who can see the client;
// this decides the actions that change something: writing to an ad account, launching in one, writing briefs, writing
// copy, reviewing creative. Pure: safe to import in the browser and on the server. The server variant
// (src/lib/chat-permissions-server.ts) loads the client's buyer seats; this one takes them in ctx.seats.
//
// The matrix (roles, never names):
// - An executive: everything, on every client, on both platforms.
// - The Head of Meta: every Meta write and launch on every client, briefs and copy. Never Google.
// - The Head of Google: every Google write and launch on every client, briefs and copy. Never Meta.
// - A Meta buyer (media_buyer): what the Head of Meta can, but writes and launches only on clients they're the Meta
//   buyer for. A Google buyer: the same for Google.
// - The Head of Creative: briefs in every format, copy, creative reviews. Never an ad account.
// - A graphic designer (lead or not): briefs and reviews for single images and carousels only. A video editor (lead or
//   not): video only. Neither writes copy or touches an ad account.
// - The copywriter: copy only (and asking about creative). No briefs, no ad account.
// - Customer success and anyone else: asking and reading only.
// Ad account actions also pass the client's live-writes switch (live_ad_writes for Meta, live_google_writes for
// Google) after this; the role is checked first.

import { formatList, normalizeFormat, type CreativeFormat } from "./creative-formats";
import { baseRole } from "./roles";

export type AdPlatform = "meta" | "google";
export type PermAction = "ads.change" | "ads.launch" | "brief" | "copy" | "creative.review";
/** A brief's format: one of ours, several ("mixed": the formats list decides), or not known yet */
export type BriefFormat = CreativeFormat | "mixed" | "unknown";

/** Someone, as the signed-in staff member (Staff fits) or by role alone */
export type Who = { role: string | null | undefined; isExec?: boolean | null };

export type PermCtx = {
  platform?: AdPlatform | null;
  format?: BriefFormat | string | null;
  /** Every format in a brief (a mixed one): all of them must be the person's */
  formats?: readonly (string | null | undefined)[] | null;
  clientId?: string | null;
  /** The buyer seats this person holds on the client (from client_assignments). Needed for a buyer's ad account actions. */
  seats?: readonly AdPlatform[] | null;
};

export type Verdict = { ok: true; reason: null } | { ok: false; reason: string };

const YES: Verdict = { ok: true, reason: null };
const no = (reason: string): Verdict => ({ ok: false, reason });

const PLATFORM_WORD: Record<AdPlatform, string> = { meta: "Meta", google: "Google Ads" };
const HEAD: Record<AdPlatform, string> = { meta: "head_of_meta", google: "head_of_google" };
const BUYER: Record<AdPlatform, string> = { meta: "media_buyer", google: "google_buyer" };
const HEAD_LABEL: Record<AdPlatform, string> = { meta: "the Head of Meta", google: "the Head of Google" };
const BUYER_LABEL: Record<AdPlatform, string> = { meta: "Meta buyer", google: "Google buyer" };

const isExec = (me: Who) => Boolean(me.isExec) || me.role === "executive";
const roleOf = (me: Who) => baseRole(me.role ?? null) ?? "";

/** The platform someone's role buys on (heads and buyers), null for anyone else */
export function buyingPlatform(me: Who): AdPlatform | null {
  const r = me.role ?? "";
  if (r === "head_of_meta" || r === "media_buyer") return "meta";
  if (r === "head_of_google" || r === "google_buyer") return "google";
  return null;
}

/** Who can do an ad account action on a platform, in words */
export function whoCanAds(action: "ads.change" | "ads.launch", platform: AdPlatform) {
  const what = action === "ads.launch" ? `Launching in ${PLATFORM_WORD[platform]}` : `Changing the ${PLATFORM_WORD[platform]} account`;
  return `${what} is for ${HEAD_LABEL[platform]}, the client's ${BUYER_LABEL[platform]} and the executives.`;
}

/** Who writes briefs in a format, in words */
function whoCanBrief(format: CreativeFormat | null) {
  if (format === "video") return "Video briefs are for the video editors, the Head of Creative, the media buyers and the executives.";
  if (format === "image" || format === "carousel") return "Image and carousel briefs are for the graphic designers, the Head of Creative, the media buyers and the executives.";
  return "Briefs are for the creative team, the media buyers and the executives.";
}

/** The formats someone may brief or review (empty: none) */
export function briefFormats(me: Who): CreativeFormat[] {
  if (isExec(me)) return formatList({ role: me.role ?? "", isExec: true });
  const r = roleOf(me);
  if (r === "copywriter" || r === "customer_success" || r === "member" || r === "coordinator" || !r) return [];
  if (r === "graphic_designer" || r === "video_editor") return formatList(r);
  if (["head_of_creative", "head_of_meta", "head_of_google", "media_buyer", "google_buyer"].includes(r)) return formatList({ role: r, isLead: true });
  return [];
}

/** Whether someone writes copy (ad copy, copy library pushes, copy in the chat) */
function copyOk(me: Who) {
  if (isExec(me)) return true;
  return ["head_of_meta", "head_of_google", "head_of_creative", "media_buyer", "google_buyer", "copywriter"].includes(roleOf(me));
}

function adsVerdict(me: Who, action: "ads.change" | "ads.launch", ctx: PermCtx): Verdict {
  const p = ctx.platform;
  if (p !== "meta" && p !== "google") return no("Say which ad account: Meta or Google Ads.");
  if (isExec(me)) return YES;
  const r = me.role ?? "";
  if (r === HEAD[p]) return YES;
  if (r === BUYER[p]) {
    if (ctx.seats?.includes(p)) return YES;
    return no(`${whoCanAds(action, p)} You're not this client's ${BUYER_LABEL[p]}.`);
  }
  return no(whoCanAds(action, p));
}

function briefVerdict(me: Who, ctx: PermCtx, verb: "brief" | "review"): Verdict {
  const allowed = briefFormats(me);
  const r = roleOf(me);
  if (!allowed.length) {
    if (verb === "brief" && r === "copywriter") return no("Briefs are written by the creative team, the media buyers and the executives. As the copywriter you can write the copy.");
    if (verb === "review") return no("Creative reviews are for the creative team, the media buyers and the executives.");
    return no(whoCanBrief(null));
  }
  const listed = [...(ctx.formats ?? []), ...(ctx.format && ctx.format !== "mixed" && ctx.format !== "unknown" ? [ctx.format] : [])]
    .map((f) => normalizeFormat(f ?? null))
    .filter((f): f is CreativeFormat => f !== null);
  const outside = listed.find((f) => !allowed.includes(f));
  if (outside) {
    if (verb === "review") return no(outside === "video" ? "Reviewing video is for the video editors, the Head of Creative, the media buyers and the executives." : "Reviewing images and carousels is for the graphic designers, the Head of Creative, the media buyers and the executives.");
    return no(whoCanBrief(outside));
  }
  return YES;
}

/** Whether this person may do this. reason: one calm sentence for the UI and the chat, saying who can. */
export function can(me: Who, action: PermAction, ctx: PermCtx = {}): Verdict {
  switch (action) {
    case "ads.change":
    case "ads.launch":
      return adsVerdict(me, action, ctx);
    case "brief":
      return briefVerdict(me, ctx, "brief");
    case "creative.review":
      return briefVerdict(me, ctx, "review");
    case "copy":
      return copyOk(me) ? YES : no("Copy is for the copywriter, the Head of Creative, the media buyers and the executives.");
  }
}

/** Changing a client's media buyer from the chat (a "team" change): executives and the heads of Meta and Google */
export function canChangeBuyer(me: Who): Verdict {
  if (isExec(me) || me.role === "head_of_meta" || me.role === "head_of_google") return YES;
  return no("Changing a client's media buyer is for the executives and the heads of Meta and Google.");
}

/** Everything one person may do on one client, serializable for the browser (cards, buttons, quick actions) */
export type ClientPerms = {
  change: Record<AdPlatform, boolean>;
  launch: Record<AdPlatform, boolean>;
  /** Why not, per platform (null: allowed) */
  changeWhy: Record<AdPlatform, string | null>;
  launchWhy: Record<AdPlatform, string | null>;
  buyer: boolean;
  briefFormats: CreativeFormat[];
  briefWhy: string | null;
  copy: boolean;
  copyWhy: string | null;
  review: boolean;
};

export function clientPerms(me: Who, seats: readonly AdPlatform[] = []): ClientPerms {
  const v = (action: "ads.change" | "ads.launch", platform: AdPlatform) => can(me, action, { platform, seats });
  const cm = v("ads.change", "meta"), cg = v("ads.change", "google"), lm = v("ads.launch", "meta"), lg = v("ads.launch", "google");
  const brief = can(me, "brief");
  const copy = can(me, "copy");
  return {
    change: { meta: cm.ok, google: cg.ok },
    launch: { meta: lm.ok, google: lg.ok },
    changeWhy: { meta: cm.reason, google: cg.reason },
    launchWhy: { meta: lm.reason, google: lg.reason },
    buyer: canChangeBuyer(me).ok,
    briefFormats: briefFormats(me),
    briefWhy: brief.reason,
    copy: copy.ok,
    copyWhy: copy.reason,
    review: can(me, "creative.review").ok,
  };
}

/**
 * What someone may do somewhere, by role alone (no client yet: Kaizen AI's tools and quick actions): a buyer counts as
 * on their own platform, since every client they act on is checked again on the server.
 */
export function roleWidePerms(me: Who): ClientPerms {
  const own = buyingPlatform(me);
  return clientPerms(me, own ? [own] : []);
}

/** Everyone allowed everything (a surface that hasn't loaded the person's permissions keeps its old behaviour) */
export const ALL_PERMS: ClientPerms = {
  change: { meta: true, google: true },
  launch: { meta: true, google: true },
  changeWhy: { meta: null, google: null },
  launchWhy: { meta: null, google: null },
  buyer: true,
  briefFormats: ["image", "carousel", "video"],
  briefWhy: null,
  copy: true,
  copyWhy: null,
  review: true,
};

/**
 * For an AI's system prompt: what this person may and may not do, so it never offers or plans what they can't. Roles,
 * not names; no em dashes.
 */
export function permsPrompt(p: ClientPerms): string {
  const yes: string[] = [];
  const nope: string[] = [];
  for (const platform of ["meta", "google"] as const) {
    const word = PLATFORM_WORD[platform];
    if (p.change[platform]) yes.push(`plan changes in the client's ${word} account`);
    else nope.push(`changes in ${word}: ${p.changeWhy[platform]}`);
    if (p.launch[platform]) yes.push(`launch in ${word}`);
    else nope.push(`launches in ${word}: ${p.launchWhy[platform]}`);
  }
  if (p.briefFormats.length === 3) yes.push("write briefs in every format");
  else if (p.briefFormats.length) yes.push(`write briefs for ${p.briefFormats.map((f) => (f === "image" ? "single images" : f === "carousel" ? "carousels" : "video")).join(" and ")} only`);
  else nope.push(`briefs: ${p.briefWhy}`);
  if (p.copy) yes.push("write ad copy");
  else nope.push(`ad copy: ${p.copyWhy}`);
  if (!p.buyer) nope.push("changing the client's media buyer: that's for the executives and the heads of Meta and Google.");
  return `What this person may do here: ${yes.length ? yes.join("; ") : "ask and read only"}.${
    nope.length
      ? ` Not theirs to do: ${nope.join(" ")} Never offer, plan or start any of these for them (no change, no launch, no brief they can't write). When they ask for one, answer the question helpfully, say plainly who can do it (by role) and offer what they can do instead.`
      : ""
  }`;
}
