import { ticketCopy } from "@/app/(team)/board/copy-actions";

// GET /api/copy/<ticket id>: the ticket's copy as it stands (progress while the AI writes). Polled with a plain fetch,
// not a server action: a page's actions run one at a time, so polling through one can sit behind another.
export async function GET(_request: Request, ctx: RouteContext<"/api/copy/[id]">) {
  const { id } = await ctx.params;
  try {
    return Response.json(await ticketCopy(id), { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Not allowed" }, { status: 401 });
  }
}
