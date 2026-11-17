// Klaviyo's answers read into the change history's shape (src/lib/email-ops/changes-core.ts): campaigns, flows with
// their steps, templates, lists, segments and forms, each with when it was created and last updated and its status.
// Pure, so it is tested without the network.

import type { ObjectSnap } from "@/lib/email-ops/changes-core";

type O = Record<string, unknown>;
const obj = (x: unknown): O => (x && typeof x === "object" ? (x as O) : {});
const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x : null);
const rows = (json: unknown): O[] => {
  const d = obj(json).data;
  return (Array.isArray(d) ? d : d ? [d] : []).map(obj);
};

/** GET /api/campaigns (fields name, status, created_at, updated_at, scheduled_at, send_time) */
export function parseCampaignSnaps(json: unknown): ObjectSnap[] {
  return rows(json)
    .map((c) => {
      const a = obj(c.attributes);
      const send = obj(a.send_strategy);
      return {
        type: "campaign" as const,
        id: String(c.id ?? ""),
        name: str(a.name) ?? "(untitled)",
        status: str(a.status),
        created: str(a.created_at),
        updated: str(a.updated_at),
        sentAt: str(a.send_time),
        scheduledAt: str(a.scheduled_at) ?? str(obj(send.options_static).datetime) ?? str(send.datetime),
      };
    })
    .filter((c) => c.id);
}

/** GET /api/flows with include=flow-actions: each flow, and each of its steps named after the flow */
export function parseFlowSnaps(json: unknown): ObjectSnap[] {
  const root = obj(json);
  const included = (Array.isArray(root.included) ? root.included : []).map(obj).filter((i) => i.type === "flow-action");
  const actions = new Map(included.map((i) => [String(i.id), obj(i.attributes)]));
  const out: ObjectSnap[] = [];
  for (const f of rows(json)) {
    const a = obj(f.attributes);
    const id = String(f.id ?? "");
    if (!id || a.archived === true) continue;
    const name = str(a.name) ?? "(untitled)";
    out.push({ type: "flow", id, name, status: str(a.status), created: str(a.created), updated: str(a.updated) });
    const ids = ((obj(obj(f.relationships)["flow-actions"]).data as unknown[] | undefined) ?? []).map((x) => String(obj(x).id));
    for (const aid of ids) {
      const s = actions.get(aid);
      if (!s) continue;
      out.push({ type: "flow_step", id: aid, name, parent: name, step: str(s.action_type), status: str(s.status), created: str(s.created), updated: str(s.updated) });
    }
  }
  return out;
}

/** GET /api/templates, /api/lists, /api/segments (fields name, created, updated) */
export function parseNamedSnaps(json: unknown, type: "template" | "list" | "segment"): ObjectSnap[] {
  return rows(json)
    .map((x) => {
      const a = obj(x.attributes);
      return { type, id: String(x.id ?? ""), name: str(a.name) ?? "(untitled)", status: null, created: str(a.created) ?? str(a.created_at), updated: str(a.updated) ?? str(a.updated_at) };
    })
    .filter((x) => x.id);
}

/** GET /api/forms (fields name, status, created_at, updated_at) */
export function parseFormSnaps(json: unknown): ObjectSnap[] {
  return rows(json)
    .map((x) => {
      const a = obj(x.attributes);
      return { type: "form" as const, id: String(x.id ?? ""), name: str(a.name) ?? "(untitled)", status: str(a.status), created: str(a.created_at) ?? str(a.created), updated: str(a.updated_at) ?? str(a.updated) };
    })
    .filter((x) => x.id);
}

/** A Klaviyo filter date: seconds, no milliseconds, UTC */
export const filterDate = (iso: string) => new Date(iso).toISOString().replace(/\.\d+Z$/, "Z");
