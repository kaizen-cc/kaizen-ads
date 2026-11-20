import "server-only";
import type { ChatTool, ToolCtx } from "./tools";

// Better briefs through the assistant and Kaizen AI: the assets a client waived or doesn't have (never asked for
// again), and the creative leads' good / needs work rating on an auto-drafted brief (a lesson for the brief writer).

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export const BRIEF_FEEDBACK_TOOLS = ["brief_asset_waivers", "waive_brief_asset", "rate_drafted_brief", "suggest_bible_change", "bible_changes", "decide_bible_change"] as const;

export function briefFeedbackTools(ctx: ToolCtx): ChatTool[] {
  const client = async (name: unknown) => {
    const { clientNamedOrNull } = await import("@/lib/client-named");
    return clientNamedOrNull(ctx.db, clip(name, 120));
  };
  const lead = ctx.me.isExec || ["head_of_creative", "lead_graphic_designer", "lead_video_editor"].includes(ctx.me.role);
  const tools: ChatTool[] = [
    {
      name: "brief_asset_waivers",
      description: "The assets a client waived or confirmed they don't have: briefs never ask for these again. Use it before asking a client for footage, photos or files.",
      input_schema: { type: "object", properties: { client: { type: "string" } }, required: ["client"], additionalProperties: false },
      status: (input) => `Checking what ${clip(input.client, 40) || "the client"} waived…`,
      run: async (input) => {
        const c = await client(input.client);
        if (!c) return { ok: false, note: "Which client?" };
        const { loadWaivers } = await import("@/lib/asset-waivers");
        return { client: c.name, waived: await loadWaivers(ctx.db, c.id) };
      },
    },
    {
      name: "waive_brief_asset",
      description: "Records that a client waived an asset, or confirmed they don't have it (how: waived or unavailable), so no brief asks for it again (\"they don't have drone footage\", \"skip the lifestyle photos for Acme\"). remove: true takes it back.",
      input_schema: { type: "object", properties: { client: { type: "string" }, asset: { type: "string", description: "The asset, in a few words (\"drone footage\")" }, how: { type: "string", enum: ["waived", "unavailable"] }, remove: { type: "boolean" } }, required: ["client", "asset"], additionalProperties: false },
      status: () => "Noting it for their briefs…",
      run: async (input) => {
        if (ctx.me.viewAs) return { ok: false, note: "Not while viewing as someone." };
        const c = await client(input.client);
        if (!c) return { ok: false, note: "Which client?" };
        const { addWaiver, removeWaiver } = await import("@/lib/asset-waivers");
        if (input.remove) {
          await removeWaiver(ctx.admin, c.id, clip(input.asset, 200));
          return { ok: true, removed: true };
        }
        return addWaiver(ctx.admin, ctx.me.id, { clientId: c.id, label: clip(input.asset, 200), how: input.how === "unavailable" ? "unavailable" : "waived" });
      },
    },
  ];
  // Safe Brand Bibles: the makers read the Bible and suggest; a lead or the Head of Creative approves
  tools.push(
    {
      name: "suggest_bible_change",
      description: "Suggests a change to a client's Brand Bible, in the person's words (what should change, and why with where they saw it). Nothing in the Bible changes until an approver (a creative lead, the Head of Creative, an exec or the account manager) approves it; then the Bible's editor writes it in. The way anyone who can't edit the Bible changes it.",
      input_schema: { type: "object", properties: { client: { type: "string" }, change: { type: "string" }, why: { type: "string" } }, required: ["client", "change", "why"], additionalProperties: false },
      status: () => "Sending your suggestion for approval…",
      run: async (input) => {
        if (ctx.me.viewAs) return { ok: false, note: "Not while viewing as someone." };
        const c = await client(input.client);
        if (!c) return { ok: false, note: "Which client?" };
        const { propose } = await import("@/lib/bible-governance");
        const r = await propose(ctx.admin, ctx.me, c.id, { kind: "edit_suggestion", answer: clip(input.change, 4000), reason: clip(input.why, 2000) });
        return r.ok ? { ok: true, note: "Sent for approval: say the Bible changes once it's approved.", open: `/clients/${c.slug}/brand-bible?change=${r.id}` } : { ok: false, note: r.error };
      },
    },
    {
      name: "bible_changes",
      description: "A client's Brand Bible proposals waiting on approval (suggested changes, avatars, answers), and whether this person may approve them.",
      input_schema: { type: "object", properties: { client: { type: "string" } }, required: ["client"], additionalProperties: false },
      status: () => "Reading the Bible's proposals…",
      run: async (input) => {
        const c = await client(input.client);
        if (!c) return { ok: false, note: "Which client?" };
        const { loadChanges, canApproveBible } = await import("@/lib/bible-governance");
        const [changes, may] = await Promise.all([loadChanges(ctx.db, c.id), canApproveBible(ctx.admin, ctx.me, c.id)]);
        return { mayApprove: may, pending: changes.filter((x) => x.status === "pending").map((x) => ({ id: x.id, kind: x.kind, what: x.answer ?? x.proposed?.name ?? x.avatar, why: x.reason, by: x.proposedBy })), open: `/clients/${c.slug}/brand-bible?changes=1` };
      },
    },
  );
  if (lead)
    tools.push({
      name: "decide_bible_change",
      description: "An approver approves or rejects one Brand Bible proposal (by id from bible_changes); a rejection needs a reason. Approved suggestions are written into the Bible. Only on their clear yes.",
      input_schema: { type: "object", properties: { client: { type: "string" }, id: { type: "string" }, approve: { type: "boolean" }, note: { type: "string" } }, required: ["client", "id", "approve"], additionalProperties: false },
      status: (input) => (input.approve ? "Approving it…" : "Rejecting it…"),
      run: async (input) => {
        const c = await client(input.client);
        if (!c) return { ok: false, note: "Which client?" };
        const { decideBibleChange } = await import("@/app/(team)/clients/[slug]/brand-bible-actions");
        return decideBibleChange(c.id, c.slug, clip(input.id, 60), Boolean(input.approve), clip(input.note, 1000));
      },
    });
  if (lead)
    tools.push({
      name: "rate_drafted_brief",
      description: "A creative lead's quick rating of an auto-drafted brief (by its id from ready_briefs): good or needs_work, with one line why (needed for needs_work). It teaches the brief writer. Rate when they say what they think of a draft.",
      input_schema: { type: "object", properties: { id: { type: "string" }, rating: { type: "string", enum: ["good", "needs_work"] }, why: { type: "string" } }, required: ["id", "rating"], additionalProperties: false },
      status: () => "Saving your rating…",
      run: async (input) => {
        const { rateDraftedBrief } = await import("@/app/(team)/brief-rating-actions");
        return rateDraftedBrief(clip(input.id, 60), input.rating === "good" ? "good" : "needs_work", clip(input.why, 300));
      },
    });
  return tools;
}
