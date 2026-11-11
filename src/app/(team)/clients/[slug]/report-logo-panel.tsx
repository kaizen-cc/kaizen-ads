import { keptBrand } from "@/lib/reports/brand-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ReportLogo } from "./report-logo";

// Team & setup › Report logo: what the client's reports carry beside Kaizen's logo (read from what's kept on the client)
export async function ReportLogoPanel({ clientId, slug, name, whiteLabel }: { clientId: string; slug: string; name: string; whiteLabel: boolean }) {
  const kept = await keptBrand(createAdminClient(), clientId).catch(() => ({}) as Awaited<ReturnType<typeof keptBrand>>);
  return <ReportLogo clientId={clientId} slug={slug} name={name} whiteLabel={whiteLabel} logo={kept.logo ?? null} light={Boolean(kept.light)} color={kept.color ?? null} source={kept.source ?? null} colorSource={kept.colorSource ?? null} uploaded={Boolean(kept.uploaded)} checked={Boolean(kept.checkedAt)} />;
}
