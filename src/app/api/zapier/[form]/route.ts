import { reportError } from "@/lib/error-report";
import { linkNewChannel } from "@/lib/context/slack";
import { createAdminClient } from "@/lib/supabase/admin";
import { after } from "next/server";
import { welcomeBack } from "@/lib/client-sync";
import { applyContacts, applyPackageText, applyTeam, flagUnmatched } from "@/lib/team-from-form";
import { processIntake, receiveIntake } from "@/lib/onboarding";
import { isZapierRequest, readEnrollment, readRaw } from "@/lib/zapier";

// Reading an intake and writing the first round runs after the reply
export const maxDuration = 300;

// POST /api/zapier/enrollment — new client form · /upsell — upsell form · /slack-channel — a client channel was just created
// /intake — the marketing intake form (every answer, as asked) · /offboarding — a client leaving (archived, nothing deleted)
// /employee-offboarding — a teammate leaving: they can't sign in, their inbox stops syncing (its email stays as history),
// and the clients they were on are listed to reassign
// Same secret as Kaizen Track; the enrollment and upsell Zaps post the same data to both apps.
export async function POST(request: Request, ctx: RouteContext<"/api/zapier/[form]">) {
  const { form } = await ctx.params;
  if (!["enrollment", "upsell", "slack-channel", "intake", "offboarding", "employee-offboarding"].includes(form)) return Response.json({ error: "Unknown form" }, { status: 404 });
  if (!isZapierRequest(request)) return Response.json({ error: "Not allowed" }, { status: 401 });

  try {
    const admin = createAdminClient();
    if (form === "slack-channel") {
      const raw = (request.headers.get("content-type") ?? "").includes("application/json")
        ? ((await request.json()) as Record<string, unknown>)
        : Object.fromEntries((await request.formData()).entries());
      const pick = (...keys: string[]) => keys.map((k) => raw[k]).find((v) => typeof v === "string" && v.trim()) as string | undefined;
      const channelId = pick("channel_id", "channelId", "id", "channel");
      if (!channelId) return Response.json({ error: "channel_id is missing" }, { status: 400 });
      return Response.json(await linkNewChannel(admin, channelId.trim()));
    }

    if (form === "intake") {
      const raw = await readRaw(request);
      if (!Object.keys(raw).length) return Response.json({ error: "The form came through empty" }, { status: 400 });
      const r = await receiveIntake(admin, raw);
      // Read it and write the first round after replying (Zapier doesn't wait a minute)
      if (r.clientId && !r.duplicate) after(() => processIntake(admin, r.id));
      return Response.json({ ok: true, intake: r.id, matched: Boolean(r.clientId), duplicate: r.duplicate });
    }

    if (form === "employee-offboarding") {
      const raw = await readRaw(request);
      const email = Object.values(raw)
        .map((v) => v.toLowerCase().match(/[\w.+-]+@kaizenmarketing\.agency/)?.[0])
        .find(Boolean);
      if (!email) return Response.json({ ok: false, error: "No @kaizenmarketing.agency email in what was sent" }, { status: 422 });
      const { data: who } = await admin.from("profiles").select("id, full_name, is_active").eq("email", email).maybeSingle();
      const now = new Date().toISOString();
      // Their inbox: not synced any more, kept as history (Sync health shows it under Offboarded)
      const { data: inbox } = await admin.from("sync_state").select("last_result").eq("source", `gmail:${email}`).maybeSingle();
      if (inbox) await admin.from("sync_state").update({ last_result: { ...((inbox.last_result ?? {}) as object), offboarded: true, offboarded_at: now } }).eq("source", `gmail:${email}`);
      if (!who) return Response.json({ ok: true, email, profile: "not in Kaizen Ads", inbox: Boolean(inbox) });
      if (who.is_active) await admin.from("profiles").update({ is_active: false }).eq("id", who.id);
      // What they were on, for a lead to hand over (assignments are kept so history still shows who did what)
      const { data: on } = await admin.from("client_assignments").select("role, clients!inner(name, archived_at)").eq("profile_id", who.id).is("clients.archived_at", null);
      const reassign = (on ?? []).map((a) => `${(a.clients as unknown as { name: string }).name} (${String(a.role).replaceAll("_", " ")})`);
      await admin.from("integration_events").upsert(
        { source: "employee-offboarding", idempotency_key: `employee-offboarding:${email}:${now.slice(0, 10)}`, payload: { raw, email, reassign }, status: "processed", processed_at: now },
        { onConflict: "idempotency_key" },
      );
      return Response.json({ ok: true, email, deactivated: who.full_name, inbox: Boolean(inbox), reassign });
    }

    if (form === "offboarding") {
      const raw = await readRaw(request);
      if (!Object.keys(raw).length) return Response.json({ error: "The form came through empty" }, { status: 400 });
      const r = await (await import("@/lib/offboarding")).receiveOffboarding(admin, raw);
      // Not matched to exactly one client: 422 so Zapier shows it, without retrying (the execs are told)
      return Response.json(r, { status: r.ok ? 200 : 422 });
    }

    const { data, key, raw } = await readEnrollment(request, form);
    if (!data.business_name && !(form === "upsell" && data.client_id))
      return Response.json({ error: form === "upsell" ? "Client ID or name is missing" : "Business name is missing" }, { status: 400 });
    const { data: result, error } = await admin.rpc("zapier_enroll", { p_key: key, p_source: form, p_data: data });
    if (error) throw new Error(`Zapier ${form}: ${error.message}`);
    // Unmatched upsell: 422 so Zapier shows it as a problem but doesn't retry
    if ((result as { error?: string })?.error) return Response.json({ ok: false, ...(result as object) }, { status: 422 });
    // An archived client enrolling again comes back with everything, as onboarding
    const enrolled = (result as { client_id?: string })?.client_id;
    const back = enrolled ? await welcomeBack(admin, enrolled) : false;
    // The team named on the form becomes the client's assignments (what each person sees follows from it)
    const team = enrolled ? await applyTeam(admin, enrolled, raw) : null;
    if (enrolled && team) await flagUnmatched(admin, enrolled, team.unmatched);
    // The client's own people named on the form become their contacts (portal link, approvals)
    const contacts = enrolled ? await applyContacts(admin, enrolled, raw).catch(() => [] as string[]) : [];
    // Anything but a plain set package ("3 Videos per Month", "Silver + 2 extra videos") becomes Custom, with
    // exactly those deliverables as the allotment
    const recognised = (result as { creative_package?: string | null })?.creative_package ?? null;
    const custom = enrolled ? await applyPackageText(admin, enrolled, data.creative_package, recognised) : null;
    // Keep the form as sent, so a question we don't read yet can be looked at later
    await admin
      .from("integration_events")
      .update({ payload: { data, raw, result: { ...(result as object), team, contacts, custom_allotment: custom } } })
      .eq("idempotency_key", key);
    return Response.json({
      ok: true,
      ...(result as object),
      ...(back ? { welcome_back: true } : {}),
      ...(team && Object.keys(team.assigned).length ? { team: team.assigned } : {}),
      ...(team?.unmatched.length ? { team_not_found: team.unmatched } : {}),
      ...(custom ? { creative_package: "custom", allotment: `${custom.images} images + ${custom.videos} videos`, package_read_as: custom.summary, package_not_recognised: null } : {}),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : `Zapier ${form} failed`;
    await reportError({ message, path: `/api/zapier/${form}`, kind: "server" });
    // A 500 makes Zapier retry later; retries are safe (each submission is processed once)
    return Response.json({ error: message }, { status: 500 });
  }
}
