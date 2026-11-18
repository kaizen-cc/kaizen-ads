import type { Metadata } from "next";
import { OpsSprintView } from "../../ops-sprint-view";

export const metadata: Metadata = { title: "Social sprint" };

/** One social sprint: the audit's moves with where each stands, the social score now against the start, and every check */
export default async function SocialSprintPage({ params }: PageProps<"/kpis/social-sprint/[id]">) {
  const { id } = await params;
  return <OpsSprintView line="social" id={id} />;
}
