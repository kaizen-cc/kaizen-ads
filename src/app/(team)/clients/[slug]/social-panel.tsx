"use client";

import { useMemo } from "react";
import { pushParams, useParam } from "@/lib/url-state";
import type { ClientSocial, SocialLinkView, SocialPlatformView } from "@/lib/social/store";
import { bestAndWeakest, filterPosts, POST_SORTS, socialStatus, sortPosts, type PostFilter, type PostSort, type PostView } from "@/lib/social/insights";
import { daysBetween } from "@/lib/social/core";
import { HealthList, Pills, Tile, ptsMove, relMove, type Move } from "./email-panel";
import { EngagementChart, FollowersChart, PLATFORM_COLOR, ReachChart } from "./social-charts";
import { SocialLink } from "./social-link";

// The Social tab: how a client's organic social is doing (Facebook Page and Instagram, read only through Meta).
// Overview (followers per platform with 30 days of growth against the 30 before, reach, engagement and rate, posting
// rhythm, 90 days of followers, reach and engagement rate, and the account's health in plain alerts) and Posts
// (sortable, with thumbnails, the best and the weakest), as tabs of the Social service in the same tab bar as Meta,
// Google and Email (?tab=). The posts' filters live in the address too (spf=, sdays=, ssort=, sdir=) so back returns to them.

const NAME = { instagram: "Instagram", facebook: "Facebook" } as const;
const SHORT = { instagram: "IG", facebook: "FB" } as const;
const FORMAT: Record<string, string> = { image: "Photo", carousel: "Carousel", reel: "Reel", video: "Video", link: "Link", text: "Text" };

const pct = (x: number | null, dp = 1) => (x == null ? "n/a" : `${(x * 100).toFixed(dp)}%`);
const count = (x: number | null) => (x == null ? "n/a" : Math.round(x).toLocaleString("en-US"));
const short = (x: number | null) => (x == null ? "n/a" : x >= 10_000 ? `${(x / 1000).toFixed(x >= 100_000 ? 0 : 1)}k` : Math.round(x).toLocaleString("en-US"));
const signed = (x: number) => `${x >= 0 ? "+" : "-"}${short(Math.abs(x))}`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "Undated");

// ─── What every Social tab opens with ──────────────────────────────────────

function Alert({ link }: { link: SocialLinkView | null }) {
  if (!link?.error) return null;
  const bad = link.error.severity === "bad";
  return (
    <div className={`grid gap-1 rounded-[14px] border px-3.5 py-3 text-[13px] leading-snug ${bad ? "border-bad/40 bg-bad-soft" : "border-warn/40 bg-warn-soft"}`} role="alert">
      <span className={`font-medium ${bad ? "text-bad" : "text-warn"}`}>{link.error.message}</span>
      <span className="text-fg/85">{link.error.fix}</span>
      {link.error.permissions.length > 0 && (
        <span className="mt-1 flex flex-wrap gap-1.5">
          {link.error.permissions.map((p) => (
            <code key={p} className="rounded-full bg-surface px-2.5 py-1 text-[11.5px] text-fg">
              {p}
            </code>
          ))}
        </span>
      )}
    </div>
  );
}

function Intro({ data, link, clientId, canEdit }: { data: ClientSocial | null; link: SocialLinkView | null; clientId: string; canEdit: boolean }) {
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-muted">
          {data ? `Facebook and Instagram · last 30 days against the 30 before${data.through ? `, data through ${new Date(`${data.through}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" })}` : ""}. Engagement rate is interactions over reach.` : "Their Facebook Page and Instagram account, read through Meta."}
        </p>
        <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] text-muted">Read only</span>
      </div>
      <Alert link={link} />
      {data?.warning && !link?.error && <p className="rounded-[12px] border border-warn/40 bg-warn-soft px-3 py-2 text-[12.5px] text-fg/90">{data.warning}</p>}
      <SocialLink clientId={clientId} link={link} canEdit={canEdit} openByDefault={canEdit && (!link || link.state === "missing")} />
    </div>
  );
}

// ─── Overview ──────────────────────────────────────────────────────────────

const noData = "Meta doesn't give this yet";

function Tiles({ d }: { d: ClientSocial }) {
  const { now, before } = d;
  const net: Move = d.followersChange == null ? null : { text: `${d.followersChange >= 0 ? "▲" : "▼"} ${short(Math.abs(d.followersChange))}`, good: d.followersChange === 0 ? null : d.followersChange > 0 };
  const lastPost = d.platforms.map((p) => p.lastPostAt).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
  const since = lastPost ? daysBetween(lastPost.slice(0, 10), d.today) : null;
  return (
    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
      <Tile k="Followers" v={short(d.followersNow)} move={net} sub={d.followersPrevChange != null ? `30 days, ${signed(d.followersPrevChange)} the 30 before` : "last 30 days"}>
        {d.platforms.length > 1 && (
          <span className="text-[11px] text-muted">
            {d.platforms.map((p) => `${SHORT[p.platform]} ${short(p.followers)}`).join(" · ")}
          </span>
        )}
      </Tile>
      <Tile k="Reach" v={short(now.reach)} move={relMove(now.reach, before.reach)} sub={now.reach == null ? noData : "accounts reached, 30 days"} />
      <Tile k="Views" v={short(now.views)} move={relMove(now.views, before.views)} sub={now.views == null ? noData : "plays and impressions"} />
      <Tile k="Interactions" v={short(now.interactions)} move={relMove(now.interactions, before.interactions)} sub={now.interactions == null ? noData : "likes, comments, saves, shares"} />
      <Tile k="Engagement rate" v={pct(now.rate)} move={ptsMove(now.rate, before.rate)} sub="interactions over reach" />
      <Tile k="Profile visits" v={short(now.profileViews)} move={relMove(now.profileViews, before.profileViews)} sub={now.profileViews == null ? noData : "last 30 days"} />
      <Tile k="Posts a week" v={String(d.postsPerWeek)} sub={since != null ? (since === 0 ? "last posted today" : `last posted ${since} day${since === 1 ? "" : "s"} ago`) : "no posts read"} />
      <Tile k="Accounts engaged" v={short(now.engaged)} move={relMove(now.engaged, before.engaged)} sub={now.engaged == null ? noData : "Instagram, 30 days"} />
    </div>
  );
}

function PlatformCard({ p, today }: { p: SocialPlatformView; today: string }) {
  const g = p.growth;
  const last = p.lastPostAt ? daysBetween(p.lastPostAt.slice(0, 10), today) : null;
  return (
    <div className="grid content-start gap-3 rounded-[16px] border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 font-medium">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PLATFORM_COLOR[p.platform] }} />
          <span className="truncate">
            {NAME[p.platform]}
            {p.name && <span className="ml-1.5 text-[12px] font-normal text-faint">{p.platform === "instagram" ? `@${p.name}` : p.name}</span>}
          </span>
        </span>
        {!p.insightsRead && <span className="shrink-0 rounded-full bg-warn-soft px-2 py-0.5 text-[10.5px] text-warn">No insights read</span>}
      </div>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
        <span className="tabular font-display text-[28px] leading-none">{short(p.followers)}</span>
        <span className="pb-0.5 text-[12px]">
          {g ? (
            <span className={g.change > 0 ? "text-ok" : g.change < 0 ? "text-bad" : "text-muted"}>
              {g.change >= 0 ? "▲" : "▼"} {short(Math.abs(g.change))}
              {g.pct != null ? ` (${(g.pct * 100).toFixed(1)}%)` : ""}
            </span>
          ) : (
            <span className="text-faint">growth builds with each day read</span>
          )}
          <span className="text-faint"> in 30 days{g?.prevChange != null ? `, ${signed(g.prevChange)} before` : ""}</span>
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4">
        {[
          ["Reach", short(p.now.reach), relMove(p.now.reach, p.before.reach)],
          ["Engagement", pct(p.now.rate), ptsMove(p.now.rate, p.before.rate)],
          ["Posts a week", String(p.postsPerWeek), null],
          ["Last post", last == null ? "n/a" : last === 0 ? "Today" : `${last}d ago`, null],
        ].map(([k, v, m]) => (
          <span key={k as string} className="grid gap-0.5 rounded-[10px] bg-surface-2/70 px-2.5 py-2">
            <span className="text-[10.5px] text-faint">{k as string}</span>
            <span className="tabular text-sm text-fg">{v as string}</span>
            {m && <span className={`text-[10.5px] ${(m as NonNullable<Move>).good == null ? "text-muted" : (m as NonNullable<Move>).good ? "text-ok" : "text-bad"}`}>{(m as NonNullable<Move>).text}</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

function Status({ d }: { d: ClientSocial }) {
  const s = socialStatus(d.health);
  const tone = { bad: "bg-bad-soft text-bad", warn: "bg-warn-soft text-warn", good: "bg-ok-soft text-ok" }[s.tone];
  return <span className={`rounded-full px-2.5 py-1 text-[11.5px] ${tone}`}>{s.label}</span>;
}

function OverviewTab({ d }: { d: ClientSocial }) {
  return (
    <div className="grid gap-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-heading text-[16px]">The last 30 days</h3>
        <Status d={d} />
      </div>
      <Tiles d={d} />
      <div className={`grid gap-2.5 ${d.platforms.length > 1 ? "md:grid-cols-2" : ""}`}>
        {d.platforms.map((p) => (
          <PlatformCard key={p.platform} p={p} today={d.today} />
        ))}
      </div>
      <FollowersChart s={d} />
      <div className="grid gap-5 lg:grid-cols-2">
        <ReachChart s={d} />
        <EngagementChart s={d} />
      </div>
      <HealthList health={d.health} />
    </div>
  );
}

// ─── Posts ────────────────────────────────────────────────────────────────

const SORT_LABEL: Record<PostSort, string> = { date: "Date", reach: "Reach", interactions: "Interactions", rate: "Rate", saves: "Saves", shares: "Shares" };
const COLS = "md:grid-cols-[minmax(0,1fr)_72px_92px_64px_60px_60px]";

function Thumb({ p, size = 56 }: { p: PostView; size?: number }) {
  return (
    <span className="relative grid shrink-0 place-items-center overflow-hidden rounded-[10px] bg-surface-2 text-[10px] uppercase tracking-[0.08em] text-faint" style={{ width: size, height: size }}>
      {p.thumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={p.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" className="absolute inset-0 h-full w-full object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />
      ) : null}
      {FORMAT[p.format]?.slice(0, 3) ?? ""}
    </span>
  );
}

function PostLine({ p }: { p: PostView }) {
  const text = p.caption?.replace(/\s+/g, " ").trim() || `${FORMAT[p.format] ?? "Post"} with no caption`;
  const inner = (
    <>
      <span className="flex min-w-0 items-center gap-3">
        <Thumb p={p} />
        <span className="grid min-w-0 gap-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-faint">
            <span className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-fg" style={{ background: `${PLATFORM_COLOR[p.platform]}33` }}>
              {SHORT[p.platform]}
            </span>
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted">{FORMAT[p.format] ?? p.format}</span>
            {when(p.postedAt)}
          </span>
          <span className="line-clamp-2 text-[13.5px] leading-snug [overflow-wrap:anywhere]">{text}</span>
        </span>
      </span>
      <span className="grid grid-cols-5 gap-2 text-[12px] md:contents">
        {[
          ["Reach", count(p.reach)],
          ["Interactions", count(p.interactions)],
          ["Rate", p.rate == null ? "n/a" : `${pct(p.rate)}${p.rateBasis === "followers" ? "*" : ""}`],
          ["Saves", count(p.saves)],
          ["Shares", count(p.shares)],
        ].map(([k, v]) => (
          <span key={k} className="grid gap-0.5 md:text-right" title={k === "Rate" && p.rateBasis === "followers" ? "Over followers: Meta gave no reach for this post" : undefined}>
            <span className="text-[10px] text-faint md:hidden">{k}</span>
            <span className="tabular text-fg">{v}</span>
          </span>
        ))}
      </span>
    </>
  );
  const cls = `grid w-full gap-2 rounded-[12px] px-3 py-3 text-left transition-colors hover:bg-surface-2/60 md:items-center md:gap-3 ${COLS}`;
  return <li className="border-t border-line/60 first:border-t-0">{p.permalink ? <a href={p.permalink} target="_blank" rel="noopener noreferrer" className={cls} aria-label={`Open the ${NAME[p.platform]} post from ${when(p.postedAt)}`}>{inner}</a> : <div className={cls}>{inner}</div>}</li>;
}

function Mini({ p, tone }: { p: PostView; tone: "ok" | "bad" }) {
  const body = (
    <span className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
      <Thumb p={p} size={48} />
      <span className="grid min-w-0 gap-0.5">
        <span className="line-clamp-2 text-[13px] leading-snug [overflow-wrap:anywhere]">{p.caption?.replace(/\s+/g, " ").trim() || `${FORMAT[p.format]} with no caption`}</span>
        <span className="text-[11.5px] text-faint">
          {SHORT[p.platform]} · {FORMAT[p.format]} · {when(p.postedAt)} · <span className={`tabular ${tone === "ok" ? "text-ok" : "text-bad"}`}>{pct(p.rate)}</span>
          {p.reach != null ? ` · ${short(p.reach)} reached` : ""}
        </span>
      </span>
    </span>
  );
  return <li>{p.permalink ? <a href={p.permalink} target="_blank" rel="noopener noreferrer" className="block min-h-11 rounded-[12px] px-2 py-2 hover:bg-surface-2/60">{body}</a> : <span className="block px-2 py-2">{body}</span>}</li>;
}

function PostsTab({ d }: { d: ClientSocial }) {
  const platformParam = useParam("spf");
  const platform: PostFilter["platform"] = platformParam === "instagram" || platformParam === "facebook" ? platformParam : "all";
  const daysParam = Number(useParam("sdays"));
  const days: PostFilter["days"] = daysParam === 60 || daysParam === 90 ? daysParam : 30;
  const sortParam = useParam("ssort") as PostSort | null;
  const sort: PostSort = sortParam && POST_SORTS.includes(sortParam) ? sortParam : "date";
  const dir = useParam("sdir") === "asc" ? "asc" : "desc";
  const inWindow = useMemo(() => filterPosts(d.posts, { platform, days }, d.today), [d.posts, d.today, platform, days]);
  const list = useMemo(() => sortPosts(inWindow, sort, dir), [inWindow, sort, dir]);
  const { best, weakest } = useMemo(() => bestAndWeakest(inWindow, 3), [inWindow]);
  const totals = inWindow.reduce((s, p) => ({ reach: s.reach + (p.reach ?? 0), inter: s.inter + (p.interactions ?? 0) }), { reach: 0, inter: 0 });
  const setSort = (s: PostSort) => pushParams({ ssort: s === "date" ? null : s, sdir: s === sort && dir === "desc" ? "asc" : null });
  const head = (s: PostSort, className = "") => (
    <button type="button" onClick={() => setSort(s)} className={`flex items-center gap-1 text-right text-[11px] uppercase tracking-[0.08em] ${sort === s ? "text-fg" : "text-faint hover:text-muted"} ${className}`}>
      {SORT_LABEL[s]}
      {sort === s && <span aria-hidden>{dir === "desc" ? "↓" : "↑"}</span>}
    </button>
  );
  const platformsHere = d.platforms.map((p) => p.platform);
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-2">
        {platformsHere.length > 1 && <Pills label="Platform" value={platform} onChange={(v) => pushParams({ spf: v === "all" ? null : v })} options={[{ id: "all", label: "All" }, { id: "instagram", label: "Instagram" }, { id: "facebook", label: "Facebook" }]} />}
        <Pills label="Window" value={String(days) as "30" | "60" | "90"} onChange={(v) => pushParams({ sdays: v === "30" ? null : v })} options={[{ id: "30", label: "30 days" }, { id: "60", label: "60 days" }, { id: "90", label: "90 days" }]} />
        <label className="flex items-center gap-2 text-[12px] text-muted md:hidden">
          Sort
          <select value={sort} onChange={(e) => pushParams({ ssort: e.target.value === "date" ? null : e.target.value, sdir: null })} className="min-h-11 rounded-full border border-line bg-surface px-3 text-[13px] text-fg">
            {POST_SORTS.map((s) => (
              <option key={s} value={s}>
                {SORT_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <span className="ml-auto text-[12px] text-faint">
          {list.length} posts · {short(totals.inter)} interactions{totals.reach ? ` · ${short(totals.reach)} reach` : ""}
        </span>
      </div>

      {(best.length > 0 || weakest.length > 0) && (
        <div className="grid gap-2.5 md:grid-cols-2">
          {best.length > 0 && (
            <section className="grid gap-2 rounded-[18px] border border-line bg-surface p-4">
              <div className="grid gap-0.5">
                <h3 className="font-heading text-[16px]">Best posts</h3>
                <span className="text-[12px] text-faint">By engagement rate</span>
              </div>
              <ul className="grid">
                {best.map((p) => (
                  <Mini key={`${p.platform}${p.id}`} p={p} tone="ok" />
                ))}
              </ul>
            </section>
          )}
          {weakest.length > 0 && (
            <section className="grid gap-2 rounded-[18px] border border-line bg-surface p-4">
              <div className="grid gap-0.5">
                <h3 className="font-heading text-[16px]">Weakest posts</h3>
                <span className="text-[12px] text-faint">Worth learning from before the next batch</span>
              </div>
              <ul className="grid">
                {weakest.map((p) => (
                  <Mini key={`${p.platform}${p.id}`} p={p} tone="bad" />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      <section className="grid gap-1 rounded-[18px] border border-line bg-surface p-2 md:p-3">
        <div className={`hidden items-center gap-3 px-3 pb-2 pt-1 md:grid ${COLS}`}>
          {head("date", "justify-start text-left")}
          {head("reach", "justify-end")}
          {head("interactions", "justify-end")}
          {head("rate", "justify-end")}
          {head("saves", "justify-end")}
          {head("shares", "justify-end")}
        </div>
        {list.length ? (
          <ul className="grid">
            {list.map((p) => (
              <PostLine key={`${p.platform}${p.id}`} p={p} />
            ))}
          </ul>
        ) : (
          <p className="px-3 py-4 text-sm text-faint">No posts in the last {days} days{platform === "all" ? "" : ` on ${NAME[platform]}`}.</p>
        )}
      </section>
      <p className="text-[12px] text-faint">Rate is interactions over the post&apos;s reach; * marks a post Meta gave no reach for, where it is over followers. Saves and shares are Instagram&apos;s own; Facebook posts count reactions, comments and shares.</p>
    </div>
  );
}

// ─── The tabs ─────────────────────────────────────────────────────────────

/**
 * The Social service's tabs, in the shape the Meta, Google and Email sections hand to the client page's ClientTabs (the
 * underlined tab bar, the open tab in ?tab=): Overview and Posts. Without numbers yet, one Overview tab says why and
 * offers the link.
 */
export type SocialTabInput = { data: ClientSocial | null; link: SocialLinkView | null; clientId: string; canEdit: boolean };

/** One Social tab's body (a client component, so the server only passes the data and which tab) */
export function SocialTab({ data, link, clientId, canEdit, tab }: SocialTabInput & { tab: "overview" | "posts" | "empty" }) {
  const text = data ? null : link?.error ? null : !link || link.state === "missing" ? "Link their Facebook Page and Instagram account to start reading." : link.state === "pending" ? "Linked. The first 90 days are being read; the numbers show here once they're in." : "Nothing has been read yet. Sync now, or wait for the next run.";
  return (
    <div className="grid gap-5">
      <Intro data={data} link={link} clientId={clientId} canEdit={canEdit} />
      {data && tab === "overview" ? <OverviewTab d={data} /> : data && tab === "posts" ? <PostsTab d={data} /> : text ? <p className="text-sm text-faint">{text}</p> : null}
    </div>
  );
}
