import { redirect } from "next/navigation";

/**
 * Next for me lives on the Overview now, under the daily recap. An old link, a bookmark or a notice lands there, at the
 * Next for me section, with whatever it carried (a brief it opened, ?brief=, is the section's ?todo= now).
 */
export default async function NextForMe({ searchParams }: PageProps<"/next">) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const x of [v].flat()) if (x != null) q.append(k === "brief" ? "todo" : k, x);
  const query = q.toString();
  redirect(`/pipeline${query ? `?${query}` : ""}#next`);
}
