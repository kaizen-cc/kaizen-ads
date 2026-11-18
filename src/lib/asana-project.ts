import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Which Asana project a line's requests and mirror use, found the same way everywhere (the Email Board's mirror and the
// deliverable flow's requests): the env var, else the app setting ({"gid": "..."}), else the workspace's project picked
// by name, else the project the mirror's last sync used (sync_state), else a fixed gid. Never a request without one.

type Admin = SupabaseClient;
type Project = { gid: string; name: string };

export type ProjectSource = {
  /** Env var holding the gid (ASANA_EMAIL_PROJECT_GID) */
  env?: string;
  /** app_settings key whose value is {"gid": "..."} */
  setting?: string;
  /** Picks the project from the workspace's projects by name */
  pick?: (projects: readonly Project[]) => Project | null;
  /** sync_state source whose last_result.project is the project the mirror last read */
  syncSource?: string;
  /** The last resort: a project known by its gid */
  fixed?: string;
};

export type FoundProject = { gid: string; from: "env" | "setting" | "name" | "sync" | "fixed" };

const GID = /^\d{6,}$/;
const gidOf = (v: unknown) => (typeof v === "string" && GID.test(v.trim()) ? v.trim() : typeof v === "number" ? String(v) : null);

/** The project, or null when nothing names one (the caller says so plainly and sends nothing) */
export async function resolveAsanaProject(admin: Admin, src: ProjectSource): Promise<FoundProject | null> {
  const env = src.env ? gidOf(process.env[src.env]) : null;
  if (env) return { gid: env, from: "env" };
  if (src.setting) {
    const { data } = await admin.from("app_settings").select("value").eq("key", src.setting).maybeSingle();
    const v = data?.value as { gid?: unknown } | string | null | undefined;
    const gid = gidOf(typeof v === "object" && v ? v.gid : v);
    if (gid) return { gid, from: "setting" };
  }
  if (src.pick && process.env.ASANA_TOKEN) {
    try {
      const { asana, asanaAll } = await import("@/lib/asana");
      for (const w of (await asana<{ gid: string }[]>("/workspaces")).data) {
        const hit = src.pick(await asanaAll<Project>("/projects", { workspace: w.gid, archived: "false", opt_fields: "name" }));
        if (hit && gidOf(hit.gid)) return { gid: hit.gid, from: "name" };
      }
    } catch {
      // Asana didn't list projects: the mirror's last project, below
    }
  }
  if (src.syncSource) {
    const { data } = await admin.from("sync_state").select("last_result").eq("source", src.syncSource).maybeSingle();
    const gid = gidOf((data?.last_result as { project?: unknown } | null)?.project);
    if (gid) return { gid, from: "sync" };
  }
  const fixed = gidOf(src.fixed);
  return fixed ? { gid: fixed, from: "fixed" } : null;
}

/** A project picked by a name pattern (archived, template and "copy of" projects left out), shortest name first */
export const pickByName =
  (re: RegExp) =>
  (projects: readonly Project[]): Project | null =>
    [...projects].filter((p) => re.test(p.name) && !/archive|template|copy of/i.test(p.name)).sort((a, b) => a.name.length - b.name.length)[0] ?? null;
