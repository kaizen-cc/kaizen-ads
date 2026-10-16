import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/** Zapier must send the shared secret (ZAPIER_SECRET in Vercel, the same value Kaizen Track uses) as `x-kaizen-secret` or a Bearer token. */
export function isZapierRequest(request: Request) {
  const secret = process.env.ZAPIER_SECRET;
  if (!secret) return false;
  const given = request.headers.get("x-kaizen-secret") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Field names are matched loosely: "What services are we providing?", "services" and
// "What_Services" all work, so Zapier can send the form's own question titles.
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
const FIELDS: Record<string, string[]> = {
  business_name: ["businessname", "clientname", "business", "client"],
  client_id: ["clientid", "clientnumber", "clientno"],
  services: ["whatservicesareweproviding", "updatedscopeofwork", "services", "scopeofwork"],
  creatives: ["arewedevelopingcreatives", "creatives", "arewedoingcreative"],
  creative_package: ["ifyeswhatcreativepackagearetheyon", "ifyouveselectedcreativeabovepleaseselectwhatpackagetheyareon", "creativepackage"],
  client_type: ["whattypeofclientisthis", "clienttype"],
  website: ["website"],
  whitelabel_for: ["whoareweprovidingwhitelabelserviceto", "whitelabelfor"],
  timestamp: ["timestamp", "submittedat"],
};

export type Enrollment = {
  business_name: string;
  /** The ops sheet's Client ID (upsell form) */
  client_id: string | null;
  services: string[];
  creatives: boolean;
  creative_package: string | null;
  client_type: string | null;
  website: string | null;
  whitelabel_for: string | null;
};

/** Read a Zapier body (JSON or form-encoded) into the fields we use, plus a key that's stable across retries. */
export async function readEnrollment(request: Request, form: string): Promise<{ data: Enrollment; key: string; raw: Record<string, unknown> }> {
  const type = request.headers.get("content-type") ?? "";
  let raw: Record<string, unknown> = {};
  if (type.includes("application/json")) raw = (await request.json()) as Record<string, unknown>;
  else raw = Object.fromEntries((await request.formData()).entries());

  const byNorm = new Map(Object.entries(raw).map(([k, v]) => [norm(k), v]));
  const pick = (f: string) => {
    for (const k of FIELDS[f]) if (byNorm.has(k)) return byNorm.get(k);
    return undefined;
  };
  const text = (v: unknown) => (v === undefined || v === null ? null : String(Array.isArray(v) ? v.join(", ") : v).trim() || null);
  const servicesRaw = pick("services");
  const services = (Array.isArray(servicesRaw) ? servicesRaw.map(String) : (text(servicesRaw) ?? "").split(","))
    .map((s) => s.trim())
    .filter(Boolean);

  const data: Enrollment = {
    business_name: text(pick("business_name")) ?? "",
    client_id: text(pick("client_id")),
    services,
    creatives: /^(yes|true|y|1)$/i.test(text(pick("creatives")) ?? ""),
    creative_package: text(pick("creative_package")),
    client_type: text(pick("client_type")),
    website: text(pick("website")),
    whitelabel_for: text(pick("whitelabel_for")),
  };
  // Same submission = same key, so Zapier retries are ignored
  const key = createHash("sha256")
    .update(JSON.stringify([form, text(pick("timestamp")) ?? JSON.stringify(raw), data.business_name.toLowerCase(), data.client_id]))
    .digest("hex");
  return { data, key, raw };
}

/** Any Zapier body as plain key/values (for the intake and offboarding forms, whose questions we keep as asked). */
export async function readRaw(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? "";
  const raw: Record<string, unknown> = type.includes("application/json") ? ((await request.json()) as Record<string, unknown>) : Object.fromEntries((await request.formData()).entries());
  return Object.fromEntries(
    Object.entries(raw)
      .map(([k, v]) => [k.trim(), (Array.isArray(v) ? v.join(", ") : v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)).trim()] as const)
      .filter(([k, v]) => k && v),
  );
}

/** The first answer whose question looks like one of these (business name, client ID, …). */
export function pickLoose(raw: Record<string, string>, keys: string[]) {
  const byNorm = new Map(Object.entries(raw).map(([k, v]) => [norm(k), v]));
  for (const k of keys) if (byNorm.get(k)) return byNorm.get(k)!;
  for (const [k, v] of byNorm) if (keys.some((x) => k.includes(x))) return v;
  return null;
}

export const stableKey = (form: string, raw: Record<string, string>) =>
  createHash("sha256").update(JSON.stringify([form, raw.timestamp ?? raw.Timestamp ?? raw.submitted_at ?? "", raw])).digest("hex");
