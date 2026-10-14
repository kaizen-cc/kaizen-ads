import { reportError } from "@/lib/error-report";
import { linkNewChannel } from "@/lib/context/slack";
import { createAdminClient } from "@/lib/supabase/admin";
import { isZapierRequest, readEnrollment } from "@/lib/zapier";

// POST /api/zapier/enrollment — new client form · /upsell — upsell form · /slack-channel — a client channel was just created
// Same forms and secret as Kaizen Track, so each Zap posts the same data to both apps.
export async function POST(request: Request, ctx: RouteContext<"/api/zapier/[form]">) {
  const { form } = await ctx.params;
  if (form !== "enrollment" && form !== "upsell" && form !== "slack-channel") return Response.json({ error: "Unknown form" }, { status: 404 });
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

    const { data, key } = await readEnrollment(request, form);
    if (!data.business_name && !(form === "upsell" && data.client_id))
      return Response.json({ error: form === "upsell" ? "Client ID or name is missing" : "Business name is missing" }, { status: 400 });
    const { data: result, error } = await admin.rpc("zapier_enroll", { p_key: key, p_source: form, p_data: data });
    if (error) throw new Error(`Zapier ${form}: ${error.message}`);
    // Unmatched upsell: 422 so Zapier shows it as a problem but doesn't retry
    if ((result as { error?: string })?.error) return Response.json({ ok: false, ...(result as object) }, { status: 422 });
    return Response.json({ ok: true, ...(result as object) });
  } catch (e) {
    const message = e instanceof Error ? e.message : `Zapier ${form} failed`;
    await reportError({ message, path: `/api/zapier/${form}`, kind: "server" });
    // A 500 makes Zapier retry later; retries are safe (each submission is processed once)
    return Response.json({ error: message }, { status: 500 });
  }
}
