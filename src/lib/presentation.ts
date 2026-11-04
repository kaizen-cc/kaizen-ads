import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AiPaused, askJson } from "@/lib/ai";
import { describeIntake, type IntakeSummary } from "@/lib/intake-format";
import { sendEmail } from "@/lib/email";

import { siteUrl } from "@/lib/site";

// The client presentation: the Brand Bible, short and beautiful, for the client ("Here's how we see you: are we
// getting this right?"). Written once a new client's Bible is in (from their intake form, or 4 business days in
// without it, which it says plainly); the client's buyer or a lead approves it, or it goes
// out on its own one business day after it's ready unless someone holds it. It goes to the client's contacts by email and to
// their Slack channel, opens in their portal, and they react section by section (spot on, or not quite and why),
// answer what we still need, pick how we launch, and approve. What they say goes back into the Bible.

export * from "@/lib/presentation-types";
import { APPROVE_AFTER_DAYS, FLOW_START, SEND_AFTER_DAYS, type Deck, type Reactions } from "@/lib/presentation-types";
import { addBusinessDays } from "@/lib/brand-bible";

const s = { type: "string" };
const o = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const list = (items: unknown) => ({ type: "array", items });
const SCHEMA = o({
  headline: s,
  intro: s,
  brand: o({ statement: s, different: list(s) }),
  goal: o({ line: s, measure: s }),
  audiences: list(o({ name: s, who: s, wants: s, hook: s })),
  voice: o({ words: list(s), sounds: s, never: list(s) }),
  ideas: list(o({ title: s, hook: s, why: s, format: { type: "string", enum: ["image", "video", "carousel"] } })),
  launch: o({ fast: s, wait: s }),
  questions: list(o({ question: s, why: s })),
});

const SYSTEM = `You turn a client's Brand Bible (the agency's long internal reference) into the short presentation the client sees first: "Here's how we see you. Are we getting this right?" It's a first impression from Kaizen Marketing, a paid social agency, so it has to feel considered, warm and sharp, and be quick to read on a phone.

Rules:
- Written to the client ("you", "your customers"), in plain words. No marketing jargon, no internal notes, no team names, no talk of problems we've found, no scores. Never mention the Bible, sources or research passes.
- Only what the Bible supports. Never invent numbers, claims, reviews or results. If the Bible doesn't know something, leave it to the questions.
- Short: every field is one or two sentences at most; lists are tight.
- headline: a confident line about them (not "Brand Bible"). intro: two sentences: what this is and that we want them to tell us where we're off.
- brand.statement: who they are and why it matters, in one sentence. brand.different: the three things that set them apart, each a short phrase.
- goal.line: what they want from ads, in their terms. goal.measure: how we'll judge it (the number if there is one).
- audiences: two or three, each with a human name ("The gift-giver"), who they are, what they want, and the line that would stop them scrolling.
- voice.words: three words for how they sound. voice.sounds: one line. voice.never: up to four things we'll never say or do.
- ideas: three or four first campaign ideas built on the angles the Bible rates highest, each with a title, the opening hook, why it should work for them, and the format.
- launch: how we get them live. fast: we can launch an engagement campaign within 48 hours using their best existing Facebook and Instagram posts, so ads are working and building an audience and site traffic right away, then move into conversion campaigns as the new creative lands. wait: if they'd rather go straight to conversion campaigns, we wait for the new creative first, which pushes the launch back until it's made. Say it in your own warm words, with fast as the recommended path, never pushy.
- questions: up to five things only the client can tell us that would sharpen the work (from the Bible's open questions for the client), each with why it matters. Plain and easy to answer.`;

/** Write (or rewrite) a client's presentation from their Bible. change: what the lead asked to be different. */
/**
 * Write the presentation from the Bible. Writing never sends it: sending stays with its own rules (a person, or the
 * one-business-day send for new clients in the new onboarding when outreach allows). When the one on file is already
 * with the client (sent or approved), the new one is drafted as a new version beside it and that one is left exactly
 * as it is; a draft that's replaced is kept as history first.
 */
export async function writePresentation(admin: SupabaseClient, clientId: string, change?: string) {
  const [{ data: c }, { data: b }, { data: intake }, { data: prev }] = await Promise.all([
    admin.from("clients").select("name, status").eq("id", clientId).single(),
    admin.from("client_brand_bibles").select("markdown, read_this_first, overview, open_questions, version").eq("client_id", clientId).maybeSingle(),
    admin.from("client_intakes").select("summary").eq("client_id", clientId).not("summary", "is", null).order("received_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("client_presentations").select("deck, status, without_intake, drafted_at, bible_version").eq("client_id", clientId).maybeSingle(),
  ]);
  if (!c || !b?.markdown) return "missing" as const;
  // Already with the client: a new version is drafted beside it, never over it
  const withClient = prev && ["sent", "approved"].includes(prev.status as string);
  let versionId: string | null = null;
  if (withClient) {
    const { data: v } = await admin.from("client_presentation_versions").insert({ client_id: clientId, status: "writing", bible_version: b.version ?? null }).select("id").single();
    versionId = (v?.id as string) ?? null;
    if (!versionId) return "failed" as const;
  } else {
    // A draft about to be replaced is kept, so nothing written is ever lost
    if (prev?.deck && !change)
      await admin.from("client_presentation_versions").insert({ client_id: clientId, status: "superseded", deck: prev.deck, without_intake: Boolean(prev.without_intake), bible_version: prev.bible_version ?? null, drafted_at: prev.drafted_at ?? null });
    await admin.from("client_presentations").upsert({ client_id: clientId, status: "writing", error: null, started_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  }
  const failVersion = (error: string) => admin.from("client_presentation_versions").update({ status: "failed", error: error.slice(0, 300) }).eq("id", versionId!);
  try {
    const forClient = ((b.open_questions ?? []) as { question: string; who: string }[]).filter((q) => /client/i.test(q.who));
    const deck = await askJson<Deck>({
      agent: "brandbible",
      label: `client presentation ${c.name}`,
      clientId,
      override: { model: "sonnet", effort: "medium" },
      system: SYSTEM,
      schema: SCHEMA,
      maxTokens: 8000,
      prompt: [
        `<client>${c.name}</client>`,
        b.overview ? `<overview>\n${JSON.stringify(b.overview)}\n</overview>` : "",
        `<read_this_first>\n${b.read_this_first ?? ""}\n</read_this_first>`,
        intake?.summary
          ? `<their_intake_form>\n${describeIntake(intake.summary as IntakeSummary)}\n</their_intake_form>`
          : `<no_intake_form>
They haven't sent their marketing intake form yet, and we didn't want to sit and wait. Say so plainly and warmly in the intro: we haven't received their intake form, but here's what we've gathered from our conversations so far, their website and our own research, and our best recommendations from it. Show we're moving: proactive, not waiting on them. Where the intake form would normally have told us something, say what we're assuming instead so they can correct it. Lead the questions with the few answers that would change the most. Don't ask them to fill in the intake form in the questions: the page has its own button for it, with their Client ID.
</no_intake_form>`,
        `<open_questions_for_the_client>\n${forClient.map((q) => `- ${q.question}`).join("\n") || "None listed."}\n</open_questions_for_the_client>`,
        `<brand_bible>\n${String(b.markdown).slice(0, 120_000)}\n</brand_bible>`,
        change && prev?.deck ? `<current_presentation>\n${JSON.stringify(prev.deck)}\n</current_presentation>\n\n<what_to_change>\n${change}\n</what_to_change>\n\nRewrite it with that change; keep what still holds.` : "Write the presentation.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    // Their swipe file: what's working in their market, for them to see the look we'd build on
    const { swipeFile } = await import("@/lib/market");
    const swipe = await swipeFile(admin, clientId, 6).catch(() => []);
    deck.swipe = swipe
      .map((a) => ({ brand: a.brand, detail: a.detail, thumb: a.media[0]?.thumb ?? (a.media[0]?.type === "image" ? a.media[0].url : null), url: a.motionUrl ?? a.libraryUrl ?? a.media[0]?.url ?? "", video: a.media[0]?.type === "video", days: a.daysActive, why: a.why ?? a.angle }))
      .filter((x) => x.url && x.thumb);
    const now = new Date();
    if (versionId) {
      await admin.from("client_presentation_versions").update({ status: "draft", deck, without_intake: !intake?.summary, error: null, drafted_at: now.toISOString() }).eq("id", versionId);
      await tellApprovers(admin, clientId, c.name as string, "version");
      return "draft" as const;
    }
    await admin
      .from("client_presentations")
      .update({ status: "draft", deck, without_intake: !intake?.summary, error: null, drafted_at: now.toISOString(), send_after: addBusinessDays(now, SEND_AFTER_DAYS).toISOString(), bible_version: b.version ?? null, updated_at: now.toISOString() })
      .eq("client_id", clientId);
    if (!change) await tellApprovers(admin, clientId, c.name as string, c.status === "onboarding" ? "auto" : "manual");
    return "draft" as const;
  } catch (e) {
    if (versionId) {
      await failVersion(e instanceof AiPaused ? "The AI was busy; tried again shortly." : e instanceof Error ? e.message : String(e));
      return "failed" as const;
    }
    if (e instanceof AiPaused) {
      await admin.from("client_presentations").update({ status: prev?.deck ? "draft" : "failed", error: "The AI was busy; tried again shortly." }).eq("client_id", clientId);
      return "failed" as const;
    }
    await admin.from("client_presentations").update({ status: prev?.deck ? "draft" : "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }).eq("client_id", clientId);
    return "failed" as const;
  }
}

/** Who approves it: the client's media buyer and the leads */
async function approvers(admin: SupabaseClient, clientId: string) {
  const [{ data: buyers }, { data: leads }] = await Promise.all([
    admin.from("client_assignments").select("profile_id").eq("client_id", clientId).eq("role", "meta_buyer"),
    admin.from("profiles").select("id").eq("is_active", true).eq("is_lead", true),
  ]);
  return [...new Set([...(buyers ?? []).map((b) => b.profile_id as string), ...(leads ?? []).map((l) => l.id as string)])];
}

async function tellApprovers(admin: SupabaseClient, clientId: string, name: string, how: "auto" | "manual" | "version") {
  const { data: c } = await admin.from("clients").select("slug").eq("id", clientId).single();
  const ids = await approvers(admin, clientId);
  if (!ids.length || !c) return;
  await admin.from("notifications").upsert(
    ids.map((id) => ({
      profile_id: id,
      kind: "onboarding",
      title: how === "version" ? `A new version of ${name}'s client presentation is drafted` : `${name}'s client presentation is ready to approve`,
      body:
        how === "version"
          ? "Written from their rebuilt Brand Bible. The one they already have stays exactly as it is; the new one is on the presentation page for the team."
          : how === "auto"
            ? "The short version of their Brand Bible, for them to react to. Have a look and send it, or it goes out on its own in one business day."
            : "The short version of their Brand Bible, for them to react to. Have a look and send it when it's right: it doesn't go out on its own.",
      href: `/clients/${c.slug}/brand-bible/presentation`,
      client_id: clientId,
      key: `presentation${how === "version" ? "-version" : ""}:${clientId}:${new Date().toISOString().slice(0, 10)}`,
      priority: "normal",
    })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
}

/** Send it: the client's contacts by email and their Slack channel, and their portal switched on so they can open it. */
export async function sendPresentation(admin: SupabaseClient, clientId: string, by: string | null) {
  const [{ data: c }, { data: p }, { data: links }] = await Promise.all([
    admin.from("clients").select("name, slug, portal_live, slack_channel_id, kaizen_id").eq("id", clientId).single(),
    admin.from("client_presentations").select("status, deck, without_intake").eq("client_id", clientId).maybeSingle(),
    admin.from("contact_clients").select("contacts(id, email, full_name, is_active)").eq("client_id", clientId),
  ]);
  if (!c || !p?.deck) return { ok: false as const, error: "There's no presentation to send." };
  if (p.status === "sent" || p.status === "approved") return { ok: false as const, error: "It's already been sent." };
  const contacts = (links ?? []).map((l) => l.contacts as unknown as { id: string; email: string; full_name: string | null; is_active: boolean } | null).filter((x): x is NonNullable<typeof x> => Boolean(x?.is_active && x.email));
  const slackOn = Boolean(process.env.SLACK_BOT_TOKEN && c.slack_channel_id);
  if (!contacts.length && !slackOn) return { ok: false as const, error: `${c.name} has no contact and no Slack channel to send it to. Add a contact on the client page first.` };
  // Their portal has to be open for them to get in
  if (!c.portal_live) await admin.from("clients").update({ portal_live: true, portal_live_at: new Date().toISOString(), portal_live_by: by }).eq("id", clientId);
  const link = `${siteUrl()}/c/${c.slug}/plan`;
  const deck = p.deck as Deck;
  const sent: string[] = [];
  const { intakeLink, logClientEmail, presentationEmail } = await import("@/lib/client-emails");
  // Their portal is open from here, so the intake is the one in it (tailored, no Client ID to type)
  const intakeUrl = intakeLink({ slug: c.slug as string, portal_live: true });
  let mail: ReturnType<typeof presentationEmail> | null = null;
  for (const x of contacts) {
    const m = presentationEmail({ brand: c.name as string, slug: c.slug as string, headline: deck.headline, withoutIntake: Boolean(p.without_intake), clientId: (c.kaizen_id as number | null) ?? null, first: x.full_name?.split(" ")[0] ?? null, intakeUrl });
    mail ??= m;
    const r = await sendEmail({ to: x.email, ...m });
    if (r.ok) sent.push(x.email);
  }
  if (mail) await logClientEmail(admin, { clientId, kind: "presentation", ...mail, to: sent, by });
  if (slackOn) {
    const text = p.without_intake
      ? `Hi team! We haven't received your intake form yet, but we didn't want to wait: from our conversations so far, your website and our research, here's how we see ${c.name} and the first campaigns we'd recommend. Tell us where we're spot on and where we're off, and fill in the few gaps (about five minutes): ${link}
When you have ten minutes, tell us about your business here: ${intakeUrl}`
      : `Hi team! We've put together how we see ${c.name}: who you're for, how you sound, and the first campaigns we'd run. Before we make anything, we'd love you to tell us where we're spot on and where we're off (about five minutes): ${link}`;
    const res = await fetch("https://slack.com/api/chat.postMessage", { method: "POST", headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ channel: c.slack_channel_id, text, unfurl_links: false }) });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
    if (body.ok) sent.push("Slack");
  }
  if (!sent.length) return { ok: false as const, error: "Nothing went out: the email and the Slack post both failed. Try again in a minute." };
  await admin.from("client_presentations").update({ status: "sent", sent_at: new Date().toISOString(), sent_by: by, sent_to: sent, updated_at: new Date().toISOString() }).eq("client_id", clientId);
  return { ok: true as const, sent };
}

/**
 * Every 10 minutes: a new client whose Bible is in gets their presentation written; one that's been ready for a
 * business day without anyone holding or sending it goes out, and one the client has had for 3 business days
 * (72 business hours) without approving is approved on its own and the team starts (onboarding clients only: one written by hand for anyone else
 * waits for a person to send it).
 */
export async function keepPresentations(admin: SupabaseClient) {
  // Clients in the new onboarding (FLOW_START) only: anyone weeks in is written and sent by hand, never a surprise first look
  const inFlow = `created_at.gte.${FLOW_START},reonboarded_at.gte.${FLOW_START}`;
  const { data: fresh } = await admin.from("clients").select("id, name").eq("status", "onboarding").is("archived_at", null).or(inFlow);
  const ids = (fresh ?? []).map((c) => c.id as string);
  const out: Record<string, string> = {};
  if (ids.length) {
    const [{ data: bibles }, { data: decks }] = await Promise.all([
      admin.from("client_brand_bibles").select("client_id, markdown, status").in("client_id", ids),
      admin.from("client_presentations").select("client_id, status, started_at").in("client_id", ids),
    ]);
    for (const c of fresh ?? []) {
      const b = (bibles ?? []).find((x) => x.client_id === c.id);
      const d = (decks ?? []).find((x) => x.client_id === c.id);
      if (!b?.markdown || b.status === "building") continue;
      // Not started, failed a while ago, or a writing run that died
      const stale = d && Date.now() - Date.parse((d.started_at as string) ?? "1970-01-01") > 30 * 60_000;
      if (d && !(stale && (d.status === "failed" || d.status === "writing"))) continue;
      out[c.name as string] = await writePresentation(admin, c.id as string);
      break; // one a run
    }
  }
  if (!Object.keys(out).length) {
    const r = await presentationForNewBible(admin);
    if (r) out[r.name] = r.result;
  }
  const { data: due } = await admin.from("client_presentations").select("client_id, clients!inner(name, status, created_at, reonboarded_at)").eq("status", "draft").eq("clients.status", "onboarding").or(inFlow, { referencedTable: "clients" }).lt("send_after", new Date().toISOString());
  const { autoOutreach } = await import("@/lib/client-outreach");
  for (const d of due ?? []) {
    // Not sent on its own to a real client until the portal is launched to them: it waits for a person to send it
    if (!(await autoOutreach(admin, d.client_id as string))) continue;
    const r = await sendPresentation(admin, d.client_id as string, null);
    out[(d.clients as unknown as { name: string } | null)?.name ?? (d.client_id as string)] = r.ok ? `sent on its own (${r.sent.join(", ")})` : r.error;
    // Couldn't go: held until someone sends it by hand, so it isn't tried every 10 minutes
    if (!r.ok) await admin.from("client_presentations").update({ status: "held", error: r.error }).eq("client_id", d.client_id);
  }
  // Theirs for 72 business hours without an answer: taken as approved, so the team isn't kept waiting
  const { data: waiting } = await admin.from("client_presentations").select("client_id, sent_at, clients!inner(name, status)").eq("status", "sent").eq("clients.status", "onboarding").not("sent_at", "is", null);
  for (const w of waiting ?? []) {
    if (addBusinessDays(w.sent_at as string, APPROVE_AFTER_DAYS) > new Date()) continue;
    if (!(await approvePresentation(admin, w.client_id as string, { by: "Approved on its own after 3 business days", contactId: null, auto: true }))) continue;
    out[(w.clients as unknown as { name: string } | null)?.name ?? (w.client_id as string)] = "approved on its own after 3 business days";
    // Folded into the Bible and the first round written, as when they approve; one a run (it takes a while)
    const { afterApproval } = await import("@/lib/plan-chat");
    await afterApproval(admin, w.client_id as string).catch((e) => console.error("[plan] after auto-approval failed:", e instanceof Error ? e.message : e));
    break;
  }
  return out;
}

/** Bibles built from here on get their presentation written automatically (older ones are written by hand) */
const AUTO_FROM = "2026-11-04T00:00:00Z";

/**
 * A Bible built or rebuilt (any client, onboarding or active) whose presentation hasn't been written from it: write it.
 * Started right after the Bible is written; this is the catch-up when that start was lost. One a run.
 */
async function presentationForNewBible(admin: SupabaseClient) {
  const { data: bibles } = await admin
    .from("client_brand_bibles")
    .select("client_id, version, generated_at, clients!inner(name, archived_at)")
    .neq("status", "building")
    .not("markdown", "is", null)
    .is("clients.archived_at", null)
    .gte("generated_at", AUTO_FROM)
    .order("generated_at", { ascending: false })
    .limit(30);
  if (!bibles?.length) return null;
  const ids = bibles.map((b) => b.client_id as string);
  const [{ data: decks }, { data: versions }] = await Promise.all([
    admin.from("client_presentations").select("client_id, status, started_at, drafted_at").in("client_id", ids),
    admin.from("client_presentation_versions").select("client_id, status, started_at").in("client_id", ids).neq("status", "superseded").order("started_at", { ascending: false }),
  ]);
  for (const b of bibles) {
    const built = Date.parse(b.generated_at as string);
    const d = (decks ?? []).find((x) => x.client_id === b.client_id);
    const v = (versions ?? []).find((x) => x.client_id === b.client_id);
    const last = Math.max(Date.parse((d?.started_at as string) ?? "1970-01-01"), Date.parse((v?.started_at as string) ?? "1970-01-01"));
    if (last >= built) {
      // Written (or being written) from this Bible: only a run that died 30 minutes ago is tried again
      const writing = (d?.status === "writing" && Date.parse(d.started_at as string) === last) || (v?.status === "writing" && Date.parse(v.started_at as string) === last);
      if (!writing || Date.now() - last < 30 * 60_000) continue;
      if (v?.status === "writing") await admin.from("client_presentation_versions").update({ status: "failed", error: "The writing run stopped" }).eq("client_id", b.client_id).eq("status", "writing");
    }
    const name = (b.clients as unknown as { name: string } | null)?.name ?? (b.client_id as string);
    return { name, result: `written from Bible ${b.version ?? ""}: ${await writePresentation(admin, b.client_id as string)}` };
  }
  return null;
}

/** Starts the presentation's writing in a run of its own once a Bible is written (the request is let go once sent) */
export async function startPresentation(clientId: string) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  const base = (process.env.NEXT_PUBLIC_SITE_URL || "https://ads.kaizenmarketing.agency").replace(/\/$/, "");
  await fetch(`${base}/api/cron/context?step=presentation_write&client=${clientId}`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(4000), cache: "no-store" }).catch(() => {});
}

/**
 * The client's plan approved, by them or on its own after 72 business hours: the team hears it (with what they marked
 * not quite, their answers and how they want to launch), the first ads are picked, and the plan is folded into the
 * Bible and the first round written.
 */
export async function approvePresentation(admin: SupabaseClient, clientId: string, o: { by: string; contactId: string | null; auto?: boolean }) {
  const [{ data: c }, { data: p }] = await Promise.all([
    admin.from("clients").select("name, slug").eq("id", clientId).single(),
    admin.from("client_presentations").select("status, reactions").eq("client_id", clientId).maybeSingle(),
  ]);
  if (!c || !p || p.status === "approved") return false;
  const reactions = (p.reactions ?? {}) as Reactions;
  // No pick from them: the recommended path (live fast with their best posts)
  const choice = reactions.launch?.choice ?? "engagement_first";
  const now = new Date().toISOString();
  await admin.from("client_presentations").update({ status: "approved", approved_at: now, approved_by: o.contactId, auto_approved: Boolean(o.auto), updated_at: now }).eq("client_id", clientId);
  const off = Object.entries(reactions.sections ?? {}).filter(([, v]) => v?.verdict === "off");
  const targets = await import("@/lib/success-measure").then(({ applyMeasure }) => applyMeasure(admin, clientId, reactions)).catch((e) => {
    console.error("[plan] applying the targets failed:", e instanceof Error ? e.message : e);
    return "";
  });
  const [{ data: buyers }, { data: leads }] = await Promise.all([
    admin.from("client_assignments").select("profile_id").eq("client_id", clientId).eq("role", "meta_buyer"),
    admin.from("profiles").select("id").eq("is_active", true).eq("is_lead", true),
  ]);
  const ids = [...new Set([...(buyers ?? []).map((b) => b.profile_id as string), ...(leads ?? []).map((x) => x.id as string)])];
  const launch = choice === "engagement_first" ? "Go live within 48 hours with an engagement campaign" : "Wait for the conversion creative before launching";
  if (ids.length)
    await admin.from("notifications").upsert(
      ids.map((id) => ({
        profile_id: id,
        kind: "onboarding",
        title: o.auto ? `${c.name}: plan approved on its own, start the work` : `${c.name} approved how we see them`,
        body: [
          o.auto ? `No answer after 3 business days, so it's approved and the team starts. ${reactions.launch ? launch : `They didn't pick how to launch: going with the recommended path (${launch.toLowerCase()}).`}` : `${o.by}: ${launch}.`,
          off.length ? `Not quite on ${off.map(([k]) => k).join(", ")}: their notes are on the presentation.` : o.auto ? "" : "Spot on everywhere they reacted.",
          targets,
        ]
          .filter(Boolean)
          .join(" "),
        href: `/clients/${c.slug}/brand-bible/presentation`,
        client_id: clientId,
        key: `presentation-approved:${clientId}`,
        priority: "critical",
      })),
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  // Their first ads are being picked from the moment it's approved (the page shows it)
  if (choice === "engagement_first") await admin.from("engagement_launches").upsert({ client_id: clientId, status: "finding", updated_at: now });
  return true;
}
