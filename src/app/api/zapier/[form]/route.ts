import { reportError } from "@/lib/error-report";
import { linkNewChannel } from "@/lib/context/slack";
import { createAdminClient } from "@/lib/supabase/admin";
import { after } from "next/server";
import { welcomeBack } from "@/lib/client-sync";
import { matchClient, processIntake, receiveIntake } from "@/lib/onboarding";
import { isZapierRequest, pickLoose, readEnrollment, readRaw } from "@/lib/zapier";

// Reading an intake and writing the first round runs after the reply
export const maxDuration = 300;

// POST /api/zapier/enrollment — new client form · /upsell — upsell form · /slack-channel — a client channel was just created
// /intake — the marketing intake form (every answer, as asked) · /offboarding — a client leaving (archived, nothing deleted)
// Same secret as Kaizen Track; the enrollment and upsell Zaps post the same data to both apps.
export async function POST(request: Request, ctx: RouteContext<"/api/zapier/[form]">) {
  const { form } = await ctx.params;
  if (!["enrollment", "upsell", "slack-channel", "intake", "offboarding"].includes(form)) return Response.json({ error: "Unknown form" }, { status: 404 });
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

    if (form === "offboarding") {
      const raw = await readRaw(request);
      const { clientId, name } = await matchClient(admin, raw);
      // No match: 422 so Zapier shows it, without retrying
      if (!clientId) return Response.json({ ok: false, error: "No matching client in Kaizen Ads", client: name }, { status: 422 });
      const reason = pickLoose(raw, ["reason", "whyaretheyleaving", "reasonforleaving", "notes"]);
      await admin.rpc("system_archive_client", { p_client: clientId, p_reason: reason ?? "Offboarding form", p_source: "zapier" });
      return Response.json({ ok: true, archived: clientId });
    }

    const { data, key } = await readEnrollment(request, form);
    if (!data.business_name && !(form === "upsell" && data.client_id))
      return Response.json({ error: form === "upsell" ? "Client ID or name is missing" : "Business name is missing" }, { status: 400 });
    const { data: result, error } = await admin.rpc("zapier_enroll", { p_key: key, p_source: form, p_data: data });
    if (error) throw new Error(`Zapier ${form}: ${error.message}`);
    // Unmatched upsell: 422 so Zapier shows it as a problem but doesn't retry
    if ((result as { error?: string })?.error) return Response.json({ ok: false, ...(result as object) }, { status: 422 });
    // An archived client enrolling again comes back with everything, as onboarding
    const enrolled = (result as { client_id?: string })?.client_id;
    const back = form === "enrollment" && enrolled ? await welcomeBack(admin, enrolled) : false;
    return Response.json({ ok: true, ...(result as object), ...(back ? { welcome_back: true } : {}) });
  } catch (e) {
    const message = e instanceof Error ? e.message : `Zapier ${form} failed`;
    await reportError({ message, path: `/api/zapier/${form}`, kind: "server" });
    // A 500 makes Zapier retry later; retries are safe (each submission is processed once)
    return Response.json({ error: message }, { status: 500 });
  }
}
