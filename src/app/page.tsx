import { redirect } from "next/navigation";
import { getViewer } from "@/lib/auth";

// Team members land on the pipeline; client contacts on their brand (or the brand picker).
export default async function Home() {
  const viewer = await getViewer();
  if (viewer.kind === "staff") redirect("/pipeline");
  if (viewer.brands.length === 1) redirect(`/c/${viewer.brands[0].slug}`);
  redirect("/c");
}
