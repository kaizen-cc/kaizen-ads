import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AiPaused, askJson } from "@/lib/ai";
import { describeIntake, type IntakeSummary } from "@/lib/intake-format";
import { sendEmail } from "@/lib/email";
import { emailHtml, emailText, type EmailParts } from "@/lib/email-layout";
import { siteUrl } from "@/lib/site";

// The client presentation: the Brand Bible, short and beautiful, for the client ("Here's how we see you: are we
// getting this right?"). Written once a new client's Bible is in (from their intake form, or 4 business days in
// without it, which it says plainly); the client's buyer or a lead approves it, or it goes
// out on its own 24 hours after it's ready unless someone holds it. It goes to the client's contacts by email and to
// their Slack channel, opens in their portal, and they react section by section (spot on, or not quite and why),
// answer what we still need, pick how we launch, and approve. What they say goes back into the Bible.

export * from "@/lib/presentation-types";
import { FLOW_START, INTAKE_FORM_URL, type Deck } from "@/lib/presentation-types";

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
export async function writePresentation(admin: SupabaseClient, clientId: string, change?: string) {
  const [{ data: c }, { data: b }, { data: intake }, { data: prev }] = await Promise.all([
    admin.from("clients").select("name").eq("id", clientId).single(),
    admin.from("client_brand_bibles").select("markdown, read_this_first, overview, open_questions").eq("client_id", clientId).maybeSingle(),
    admin.from("client_intakes").select("summary").eq("client_id", clientId).not("summary", "is", null).order("received_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("client_presentations").select("deck").eq("client_id", clientId).maybeSingle(),
  ]);
  if (!c || !b?.markdown) return "missing" as const;
  await admin.from("client_presentations").upsert({ client_id: clientId, status: "writing", error: null, started_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  try {
    const forClient = ((b.open_questions ?? []) as { question: string; who: string }[]).filter((q) => /client/i.test(q.who));
    const deck = await askJson<Deck>({
      agent: "brandbible",
      label: `client presentation ${c.name}`,
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
    const now = new Date();
    await admin
      .from("client_presentations")
      .update({ status: "draft", deck, without_intake: !intake?.summary, error: null, drafted_at: now.toISOString(), send_after: new Date(now.getTime() + 24 * 3_600_000).toISOString(), updated_at: now.toISOString() })
      .eq("client_id", clientId);
    if (!change) await tellApprovers(admin, clientId, c.name as string);
    return "draft" as const;
  } catch (e) {
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

async function tellApprovers(admin: SupabaseClient, clientId: string, name: string) {
  const { data: c } = await admin.from("clients").select("slug").eq("id", clientId).single();
  const ids = await approvers(admin, clientId);
  if (!ids.length || !c) return;
  await admin.from("notifications").upsert(
    ids.map((id) => ({
      profile_id: id,
      kind: "onboarding",
      title: `${name}'s client presentation is ready to approve`,
      body: "The short version of their Brand Bible, for them to react to. Have a look and send it, or it goes out on its own in 24 hours.",
      href: `/clients/${c.slug}/brand-bible/presentation`,
      client_id: clientId,
      key: `presentation:${clientId}:${new Date().toISOString().slice(0, 10)}`,
      priority: "normal",
    })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
}

function touchpointEmail(p: { firstName: string | null; brand: string; headline: string; link: string; withoutIntake: boolean; clientId: number | null }) {
  const subject = p.withoutIntake ? `${p.brand}: we got started, here's what we've got` : `${p.brand}: are we getting this right?`;
  const parts: EmailParts = {
    preheader: p.headline,
    kicker: p.brand,
    title: p.withoutIntake ? "We got started for you" : "Are we getting this right?",
    highlight: p.withoutIntake ? "started" : "right",
    hello: p.firstName ? `Hi ${p.firstName},` : "Hi there,",
    lines: [
      p.withoutIntake
        ? "We haven't received your intake form yet, but we didn't want to wait. From our conversations, your website and our own research, here's how we see you:"
        : "Thanks for your intake form. From everything you told us, plus our own research, here's how we see you:",
    ],
    bullets: ["Who you are and what makes you different", "Who we'll be speaking to, and what stops them scrolling", "How you sound", "The first campaigns we'd run", "How we get you live"],
    cta: { label: "See how we see you →", url: p.link },
    note: [
      "Tap Spot on or Not quite on each part, or just talk it through with us. About five minutes.",
      p.withoutIntake ? `When you have ten minutes, the intake form is here: ${INTAKE_FORM_URL}${p.clientId != null ? ` (your Client ID: ${p.clientId})` : ""}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
  return { subject, text: emailText(parts), html: emailHtml(parts) };
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
  for (const x of contacts) {
    const r = await sendEmail({ to: x.email, ...touchpointEmail({ firstName: x.full_name?.split(" ")[0] ?? null, brand: c.name as string, headline: deck.headline, link, withoutIntake: Boolean(p.without_intake), clientId: (c.kaizen_id as number | null) ?? null }) });
    if (r.ok) sent.push(x.email);
  }
  if (slackOn) {
    const text = p.without_intake
      ? `Hi team! We haven't received your intake form yet, but we didn't want to wait: from our conversations so far, your website and our research, here's how we see ${c.name} and the first campaigns we'd recommend. Tell us where we're spot on and where we're off, and fill in the few gaps (about five minutes): ${link}
When you have ten minutes, the intake form is here: ${INTAKE_FORM_URL}${c.kaizen_id != null ? ` (your Client ID: ${c.kaizen_id})` : ""}`
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
 * Every 10 minutes: a new client whose Bible is in gets their presentation written; one that's been ready for 24
 * hours without anyone holding or sending it goes out (onboarding clients only: one written by hand for anyone else
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
  const { data: due } = await admin.from("client_presentations").select("client_id, clients!inner(name, status, created_at, reonboarded_at)").eq("status", "draft").eq("clients.status", "onboarding").or(inFlow, { referencedTable: "clients" }).lt("send_after", new Date().toISOString());
  for (const d of due ?? []) {
    const r = await sendPresentation(admin, d.client_id as string, null);
    out[(d.clients as unknown as { name: string } | null)?.name ?? (d.client_id as string)] = r.ok ? `sent on its own (${r.sent.join(", ")})` : r.error;
    // Couldn't go: held until someone sends it by hand, so it isn't tried every 10 minutes
    if (!r.ok) await admin.from("client_presentations").update({ status: "held", error: r.error }).eq("client_id", d.client_id);
  }
  return out;
}
