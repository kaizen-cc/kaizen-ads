import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { asana, asanaWrite, projectGid } from "@/lib/asana";
import { conceptLine, unitsFor } from "@/lib/allotment";
import { primaryOf, type SeatRow } from "@/lib/buyer-seats";

// A creative request briefed in Kaizen Ads, sent to the Creative board in Asana built exactly like the Google Form's
// tasks, so the creative team sees nothing different while briefing moves here: one task per format, named
// "Meta Ads - Need a new creative - {Client} - {Format}", in the Creative Brief column, the Client ID field set, assigned
// to the client's designer or video editor, and the description in the form's order (media buyer, platform, type,
// audience, angle, what to focus on), then the format's required AI prompts, the client's quick links and the "ready
// for the client" form. The mirror then shows it on the Board like any Asana task (counted once in the allotment).

export type AsanaFormat = "image" | "video" | "carousel";
export type AsanaDraft = {
  clientId: string;
  title: string;
  formats: Partial<Record<AsanaFormat, { new: number; variations: number; cards?: number }>>;
  sizes: string[];
  angle: string;
  /** A Brand Bible avatar by name, or a new one under test */
  avatar?: string;
  avatarTest?: boolean;
  audience: string;
  brief: string;
  refs: string;
  landing?: string;
  priority: string;
};
export type PlannedTask = {
  format: AsanaFormat;
  name: string;
  section: string;
  notes: string;
  assignee: { name: string; email: string | null } | null;
  dueOn: string | null;
  fields: { name: string; value: string }[];
};
export type SentTask = { gid: string; url: string | null; format: AsanaFormat; name: string; assigned: boolean };

type Template = { platform: string; section: string; blocks: Partial<Record<AsanaFormat, string>>; readyForm: string };
const FORMAT_IN_NAME: Record<AsanaFormat, string> = { image: "Image", video: "Video", carousel: "Carousel" };
const FORMAT_TYPE: Record<AsanaFormat, string> = { image: "Single Image", video: "Video", carousel: "Carousel" };
const MAKER: Record<AsanaFormat, string> = { image: "graphic_designer", carousel: "graphic_designer", video: "video_editor" };
// The Board's turnaround in business days (halved for urgent), the same as a ticket made here
const TURNAROUND: Record<AsanaFormat, number> = { image: 2, video: 4, carousel: 2 };
const ORDER: AsanaFormat[] = ["image", "video", "carousel"];

const links = (refs: string) => refs.split(/\s+/).filter((u) => /^https?:\/\//i.test(u)).slice(0, 20);
const first = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] ?? "";

/** A date a number of business days from today, New York, as YYYY-MM-DD */
function businessDaysFromNow(days: number) {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  let n = 0;
  while (n < days) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) n++;
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function template(admin: SupabaseClient): Promise<Template> {
  const { data } = await admin.from("app_settings").select("value").eq("key", "asana_request_template").maybeSingle();
  const v = (data?.value ?? {}) as Partial<Template>;
  return { platform: v.platform ?? "Meta Ads", section: v.section ?? "Creative Brief", blocks: v.blocks ?? {}, readyForm: v.readyForm ?? "" };
}

/** The tasks a request becomes on the Creative board: what each will say, who it's for, when it's due. Nothing is sent. */
export async function planAsanaRequest(admin: SupabaseClient, d: AsanaDraft): Promise<PlannedTask[]> {
  const [{ data: c }, { data: seats }, t] = await Promise.all([
    admin.from("clients").select("name, kaizen_id, website, drive_folder_id, creative_db").eq("id", d.clientId).single(),
    admin.from("client_assignments").select("role, profile_id, is_primary, created_at, profiles(full_name, email)").eq("client_id", d.clientId),
    template(admin),
  ]);
  if (!c) throw new Error("Client not found.");
  // The seat's primary (a client with a secondary buyer still has one buyer on the task)
  const seat = (role: string) => (primaryOf((seats ?? []) as unknown as (SeatRow & { profiles: { full_name: string; email: string | null } | null })[], role)?.profiles ?? null);
  const buyer = seat("meta_buyer");
  const urgent = d.priority === "urgent";
  const high = urgent || d.priority === "high";
  const sizes = d.sizes.map((z) => z.replace("x", ":")).join(" + ");
  const db = (c.creative_db as { url?: string } | null)?.url ?? "";
  const hq = c.drive_folder_id ? `https://drive.google.com/open?id=${c.drive_folder_id}` : "";
  const refs = links(d.refs);
  const formats = ORDER.filter((f) => d.formats[f] && d.formats[f]!.new + d.formats[f]!.variations > 0);
  return formats.map((f) => {
    const k = d.formats[f]!;
    const count = k.new + k.variations;
    const what = f === "image" ? "image" : f;
    // One concept per brief, every version counted: "1 concept, 3 versions (1 new image, 2 variations)"
    const split = [k.new ? `${k.new} new ${what}${k.new === 1 ? "" : "s"}` : "", k.variations ? `${k.variations} variation${k.variations === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
    const units = unitsFor(f, k);
    const deliverables = `${conceptLine(f, k)} (${split}); counts ${units} toward the allotment`;
    const maker = seat(MAKER[f]);
    const notes = [
      `Media Buyer Assigned to Account: ${first(buyer?.full_name)}`,
      `Platform: ${t.platform}`,
      `Type of Creative: ${FORMAT_TYPE[f]}`,
      `Deliverables: ${deliverables}${sizes ? ` (${sizes})` : ""}`,
      `Intended Audience: ${d.audience.trim()}`,
      ...(d.avatar?.trim() ? [`Avatar: ${d.avatar.trim()}${d.avatarTest ? " (avatar test: not in the Brand Bible yet)" : ""}`] : []),
      `Creative Angle: ${d.angle.trim()}`,
      ...(d.avatar?.trim() || d.angle.trim() ? [`Name files and folders by: ${[d.avatar?.trim(), d.angle.trim()].filter(Boolean).join(" - ")}`] : []),
      `Anything Specific to focus on: ${d.brief.trim()}`,
      "",
      ...(refs.length ? ["References:", ...refs, ""] : []),
      ...(d.landing?.trim() ? [`Landing page: ${d.landing.trim()}`, ""] : []),
      ...(t.blocks[f] ? [t.blocks[f]!, ""] : []),
      "Client Quick Links: ",
      `Headquarters: ${hq}`,
      `Website: ${c.website ?? ""}`,
      `Link to Client's Creative Database: ${db}`,
      ...(t.readyForm ? ["", "Submit this form when we have copy AND creative ready for the client's review:", t.readyForm] : []),
    ].join("\n");
    const fields = [{ name: "Client ID", value: c.kaizen_id != null ? String(c.kaizen_id) : "" }, ...(high ? [{ name: "Priority", value: urgent ? "URGENT" : "HIGH" }] : [])].filter((x) => x.value);
    return {
      format: f,
      name: `${urgent ? "URGENT: " : ""}Meta Ads - Need a new creative - ${c.name} - ${FORMAT_IN_NAME[f]}${count > 1 ? ` (x${count})` : ""}${d.title.trim() ? ` - ${d.title.trim()}` : ""}`.slice(0, 250),
      section: t.section,
      notes,
      assignee: maker ? { name: maker.full_name, email: maker.email } : null,
      dueOn: businessDaysFromNow(urgent ? Math.max(1, Math.floor(TURNAROUND[f] / 2)) : TURNAROUND[f]),
      fields,
    };
  });
}

type FieldSetting = { custom_field: { gid: string; name: string; resource_subtype: string; enum_options?: { gid: string; name: string; enabled?: boolean }[] } };

/** The project's custom fields as Asana wants them: { gid: value } (text, number or the matching enum option) */
async function fieldValues(project: string, fields: PlannedTask["fields"]) {
  const settings = (await asana<FieldSetting[]>(`/projects/${project}/custom_field_settings`, { opt_fields: "custom_field.gid,custom_field.name,custom_field.resource_subtype,custom_field.enum_options.gid,custom_field.enum_options.name,custom_field.enum_options.enabled" })).data;
  const out: Record<string, string | number> = {};
  for (const f of fields) {
    const s = settings.find((x) => x.custom_field.name.trim().toLowerCase() === f.name.toLowerCase()) ?? settings.find((x) => new RegExp(f.name.replace(/\s+/g, "\\s*"), "i").test(x.custom_field.name));
    if (!s) continue;
    const cf = s.custom_field;
    if (cf.resource_subtype === "number") {
      const n = Number(f.value);
      if (Number.isFinite(n)) out[cf.gid] = n;
    } else if (cf.resource_subtype === "enum") {
      const opts = (cf.enum_options ?? []).filter((o) => o.enabled !== false);
      const want = f.value.toLowerCase();
      const o = opts.find((x) => x.name.toLowerCase() === want) ?? opts.find((x) => new RegExp(want === "urgent" ? "urgent|high" : want, "i").test(x.name));
      if (o) out[cf.gid] = o.gid;
    } else out[cf.gid] = f.value;
  }
  return out;
}

/**
 * Sends the request to the Creative board: the planned tasks, each created in the Creative Brief column with its
 * fields, assignee (by email; created unassigned if Asana doesn't know them) and the sender as a follower. Kept as a sent
 * request, and put on the mirror straight away (marked as made in Kaizen Ads) so the Board shows it now.
 */
export async function sendAsanaRequest(admin: SupabaseClient, d: AsanaDraft, by: { id: string; email: string | null }, extra: { suggestionId?: string | null; origin?: Record<string, unknown> | null } = {}) {
  const planned = await planAsanaRequest(admin, d);
  if (!planned.length) throw new Error("Pick at least one format.");
  const project = await projectGid(admin);
  const sections = (await asana<{ gid: string; name: string }[]>(`/projects/${project}/sections`, { opt_fields: "name" })).data;
  const section = sections.find((x) => x.name.trim().toLowerCase() === planned[0].section.toLowerCase()) ?? sections.find((x) => /^creative brief/i.test(x.name.trim())) ?? null;
  const sent: SentTask[] = [];
  for (const p of planned) {
    const custom_fields = await fieldValues(project, p.fields).catch(() => ({}));
    const base: Record<string, unknown> = {
      name: p.name,
      notes: p.notes.slice(0, 60000),
      ...(section ? { memberships: [{ project, section: section.gid }] } : { projects: [project] }),
      ...(p.dueOn ? { due_on: p.dueOn } : {}),
      ...(Object.keys(custom_fields).length ? { custom_fields } : {}),
      ...(by.email ? { followers: [by.email] } : {}),
    };
    let task: { gid: string; permalink_url?: string };
    let assigned = Boolean(p.assignee?.email);
    try {
      task = await asanaWrite<{ gid: string; permalink_url?: string }>("/tasks?opt_fields=permalink_url", { ...base, ...(p.assignee?.email ? { assignee: p.assignee.email } : {}) });
    } catch (e) {
      // Someone Asana doesn't know by that email (or a follower it can't add): made without them, never lost
      if (!p.assignee?.email && !by.email) throw e;
      const { followers: _f, ...rest } = base;
      void _f;
      task = await asanaWrite<{ gid: string; permalink_url?: string }>("/tasks?opt_fields=permalink_url", rest);
      assigned = false;
    }
    sent.push({ gid: task.gid, url: task.permalink_url ?? null, format: p.format, name: p.name, assigned });
  }

  const { data: row } = await admin
    .from("asana_sent_requests")
    .insert({ client_id: d.clientId, suggestion_id: extra.suggestionId ?? null, draft: d, tasks: sent, origin: extra.origin ?? null, sent_by: by.id })
    .select("id")
    .single();
  // On the Board now (the next sync fills in the rest), counted once like any Asana task, never also a ticket
  const { data: c } = await admin.from("clients").select("kaizen_id").eq("id", d.clientId).single();
  const emails = [...new Set(planned.map((p) => p.assignee?.email?.toLowerCase()).filter((e): e is string => Boolean(e)))];
  const { data: people } = emails.length ? await admin.from("profiles").select("id, email").in("email", emails) : { data: [] as { id: string; email: string }[] };
  const now = new Date().toISOString();
  await admin.from("asana_tasks").upsert(
    sent.map((t) => {
      const p = planned.find((x) => x.name === t.name)!;
      return {
        gid: t.gid,
        name: t.name,
        notes: p.notes.slice(0, 20000),
        section: section?.name ?? p.section,
        stage: "requested",
        client_id: d.clientId,
        client_ref: c?.kaizen_id != null ? String(c.kaizen_id) : null,
        platform: "Meta Ads",
        format: t.format,
        priority: d.priority === "urgent" ? "URGENT" : d.priority === "high" ? "HIGH" : null,
        assignee_name: t.assigned ? (p.assignee?.name ?? null) : null,
        assignee_email: t.assigned ? (p.assignee?.email?.toLowerCase() ?? null) : null,
        profile_id: t.assigned ? ((people ?? []).find((x) => x.email?.toLowerCase() === p.assignee?.email?.toLowerCase())?.id ?? null) : null,
        due_on: p.dueOn,
        url: t.url ?? `https://app.asana.com/0/${project}/${t.gid}`,
        fields: Object.fromEntries(p.fields.map((f) => [f.name, f.value])),
        open: true,
        asana_created_at: now,
        asana_modified_at: now,
        synced_at: now,
        from_kaizen_ads: true,
        sent_request_id: row?.id ?? null,
        // What it takes from the allotment, counted here (the Asana counter reads the same rule from the description)
        new_images: t.format === "video" ? 0 : unitsFor(t.format, d.formats[t.format]),
        new_videos: t.format === "video" ? unitsFor("video", d.formats.video) : 0,
        concepts: 1,
      };
    }),
  );
  if (extra.suggestionId)
    await admin
      .from("creative_suggestions")
      .update({ status: "approved", decided_by: by.id, decided_at: now, asana: sent })
      .eq("id", extra.suggestionId)
      .eq("status", "open");
  return { id: (row?.id as string | undefined) ?? null, tasks: sent };
}
