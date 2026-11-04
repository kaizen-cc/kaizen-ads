import { ticketDesigns } from "@/app/(team)/board/design-actions";
import { ticketComments } from "@/app/(team)/board/review-actions";

// GET /api/board/media/<ticket id>: a ticket's creative (every version, links signed in one batch) and its review
// comments, in one request. A plain fetch, not server actions: a page's actions run one at a time, so the files would
// wait behind the history, the AI review and the copy. The board prefetches it as a card is hovered or opened.
export async function GET(_request: Request, ctx: RouteContext<"/api/board/media/[id]">) {
  const { id } = await ctx.params;
  try {
    const [designs, comments] = await Promise.all([ticketDesigns(id), ticketComments(id)]);
    return Response.json({ designs, comments }, { headers: { "cache-control": "private, no-store" } });
  } catch {
    return Response.json({ error: "Not allowed" }, { status: 401 });
  }
}
