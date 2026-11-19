import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatViewAsCookie,
  isViewAsMessage,
  outboundVerdict,
  parseViewAsCookie,
  representativeFor,
  roleView,
  VIEW_AS_COOKIE,
  VIEW_AS_HEADER,
  ViewAsReadOnlyError,
  viewAsMessage,
} from "@/lib/view-as-core";

// View as: only the owner (profiles.can_view_as) switches the app to a teammate's view, and while it's on nothing is
// written or sent: database changes are refused with a clear message, outside calls that change anything never leave.

const OWNER = "3a8c8d77-a98c-4c00-8d6f-1a3ff66b94e5";
const PETER = "c3a3303e-9a63-4474-b093-c91a64ef46b8";
const OTHER_EXEC = "11111111-1111-4111-8111-111111111111";
const SUPA = "https://proj.supabase.co";

// The request's cookies, as next/headers hands them out
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
  headers: async () => new Headers(),
}));

// Who is signed in, and the profiles the session can read
const session = { uid: "auth-owner" as string | null };
const profiles: Record<string, unknown>[] = [
  { id: OWNER, auth_user_id: "auth-owner", full_name: "Santi Lozano", role: "executive", is_active: true, can_view_as: true, is_exec: true },
  { id: OTHER_EXEC, auth_user_id: "auth-exec", full_name: "Other Exec", role: "executive", is_active: true, can_view_as: false, is_exec: true },
  { id: PETER, auth_user_id: "auth-peter", full_name: "Peter Gonzalez", role: "head_of_social", is_active: true, can_view_as: false, is_exec: false },
  { id: "22222222-2222-4222-8222-222222222222", auth_user_id: null, full_name: "Gone Person", role: "media_buyer", is_active: false, can_view_as: false, is_exec: false },
];
function fakeSession() {
  const from = (table: string) => {
    let rows = table === "profiles" ? [...profiles] : [];
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => ((rows = rows.filter((r) => r[k] === v)), q),
      neq: (k: string, v: unknown) => ((rows = rows.filter((r) => r[k] !== v)), q),
      maybeSingle: async () => ({ data: rows[0] ?? null }),
      then: (ok: (v: { data: unknown[] }) => unknown) => Promise.resolve({ data: rows }).then(ok),
    };
    return q;
  };
  return { auth: { getClaims: async () => ({ data: session.uid ? { claims: { sub: session.uid } } : null }) }, from };
}
vi.mock("@/lib/supabase/session", () => ({ createSessionClient: async () => fakeSession() }));

beforeEach(() => {
  jar.clear();
  session.uid = "auth-owner";
});

describe("the view-as cookie", () => {
  it("round-trips a person and a role, and refuses anything else", () => {
    const person = parseViewAsCookie(formatViewAsCookie({ id: PETER, role: null, name: "Peter Gonzalez" }));
    expect(person).toEqual({ id: PETER, role: null, name: "Peter Gonzalez" });
    const role = parseViewAsCookie(formatViewAsCookie({ id: PETER, role: "head_of_social", name: "Peter Gonzalez" }));
    expect(role?.role).toBe("head_of_social");
    expect(parseViewAsCookie("not-an-id|executive|x")).toBeNull();
    expect(parseViewAsCookie(`${PETER}|god_mode|x`)?.role).toBeNull();
    expect(parseViewAsCookie(null)).toBeNull();
  });

  it("says the same one line everywhere", () => {
    expect(viewAsMessage("Peter Gonzalez")).toBe("You're viewing as Peter Gonzalez: exit to make changes.");
    expect(isViewAsMessage(new ViewAsReadOnlyError("Peter Gonzalez").message)).toBe(true);
    expect(isViewAsMessage("Something else broke")).toBe(false);
  });
});

describe("the gate: only the owner's own profile can view as", () => {
  it("answers as the target for the owner", async () => {
    jar.set(VIEW_AS_COOKIE, formatViewAsCookie({ id: PETER, role: null, name: "Peter Gonzalez" }));
    const { activeViewAs } = await import("@/lib/view-as");
    const va = await activeViewAs();
    expect(va?.target.id).toBe(PETER);
    expect(va?.actorId).toBe(OWNER);
    expect(va?.label).toBe("Peter Gonzalez (Head of Organic Social)");
  });

  it("names the role first when a role was picked", async () => {
    jar.set(VIEW_AS_COOKIE, formatViewAsCookie({ id: PETER, role: "head_of_social", name: "Peter Gonzalez" }));
    const { activeViewAs } = await import("@/lib/view-as");
    expect((await activeViewAs())?.label).toBe("Head of Organic Social (shown through Peter Gonzalez)");
  });

  it("is ignored for another executive (gated by profile, never by role)", async () => {
    session.uid = "auth-exec";
    jar.set(VIEW_AS_COOKIE, formatViewAsCookie({ id: PETER, role: null, name: "Peter Gonzalez" }));
    const { activeViewAs } = await import("@/lib/view-as");
    expect(await activeViewAs()).toBeNull();
  });

  it("is ignored for a teammate who forges the cookie, signed out, on themselves, or on someone inactive", async () => {
    const { activeViewAs } = await import("@/lib/view-as");
    session.uid = "auth-peter";
    jar.set(VIEW_AS_COOKIE, formatViewAsCookie({ id: OWNER, role: null, name: "Santi" }));
    expect(await activeViewAs()).toBeNull();
    session.uid = null;
    expect(await activeViewAs()).toBeNull();
    session.uid = "auth-owner";
    jar.set(VIEW_AS_COOKIE, formatViewAsCookie({ id: OWNER, role: null, name: "Santi" }));
    expect(await activeViewAs()).toBeNull();
    jar.set(VIEW_AS_COOKIE, formatViewAsCookie({ id: "22222222-2222-4222-8222-222222222222", role: null, name: "Gone" }));
    expect(await activeViewAs()).toBeNull();
  });

  it("does nothing (no database) when nothing is chosen", async () => {
    const { activeViewAs } = await import("@/lib/view-as");
    expect(await activeViewAs()).toBeNull();
  });

  it("refuses the picker and the switch to anyone but the owner", async () => {
    session.uid = "auth-exec";
    const { viewAsOptions, startViewAs } = await import("@/app/(team)/view-as-actions");
    expect(await viewAsOptions()).toEqual({ ok: false, error: "View as is only for the owner." });
    expect(await startViewAs({ personId: PETER })).toEqual({ ok: false, error: "View as is only for the owner." });
    expect(jar.has(VIEW_AS_COOKIE)).toBe(false);
  });
});

describe("the write block", () => {
  it("lets reads through and refuses every change to a person's world", () => {
    expect(outboundVerdict("GET", "https://slack.com/api/chat.postMessage")).toBe("allow");
    expect(outboundVerdict("POST", "https://slack.com/api/chat.postMessage")).toBe("block");
    expect(outboundVerdict("POST", "https://slack.com/api/conversations.history")).toBe("allow");
    expect(outboundVerdict("POST", "https://api.resend.com/emails")).toBe("block");
    expect(outboundVerdict("POST", "https://graph.facebook.com/v21.0/act_1/ads")).toBe("block");
    expect(outboundVerdict("POST", "https://googleads.googleapis.com/v21/customers/1/googleAds:searchStream")).toBe("allow");
    expect(outboundVerdict("POST", "https://googleads.googleapis.com/v21/customers/1/campaigns:mutate")).toBe("block");
    expect(outboundVerdict("POST", "https://app.asana.com/api/1.0/tasks")).toBe("block");
    expect(outboundVerdict("POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send")).toBe("block");
    expect(outboundVerdict("POST", "/api/assistant")).toBe("block");
    // The AI the assistant thinks with still works
    expect(outboundVerdict("POST", "https://api.anthropic.com/v1/messages")).toBe("allow");
  });

  it("refuses Supabase table and storage changes, lets reads and RPCs through (the database runs them read only)", () => {
    expect(outboundVerdict("PATCH", `${SUPA}/rest/v1/profiles?id=eq.1`, SUPA)).toBe("block-supabase");
    expect(outboundVerdict("POST", `${SUPA}/rest/v1/notifications`, SUPA)).toBe("block-supabase");
    expect(outboundVerdict("DELETE", `${SUPA}/rest/v1/briefs?id=eq.1`, SUPA)).toBe("block-supabase");
    expect(outboundVerdict("POST", `${SUPA}/storage/v1/object/briefs/a.png`, SUPA)).toBe("block-supabase");
    expect(outboundVerdict("POST", `${SUPA}/rest/v1/rpc/my_clients`, SUPA)).toBe("allow");
    expect(outboundVerdict("POST", `${SUPA}/storage/v1/object/sign/briefs/a.png`, SUPA)).toBe("allow");
    expect(outboundVerdict("GET", `${SUPA}/rest/v1/clients`, SUPA)).toBe("allow");
  });

  it("the guarded fetch: tags reads, answers a refused database change with the message, throws for outside sends", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPA);
    jar.set(VIEW_AS_COOKIE, formatViewAsCookie({ id: PETER, role: null, name: "Peter Gonzalez" }));
    const seen: { url: string; headers: Headers }[] = [];
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    const { viewAsFetch } = await import("@/lib/view-as-fetch");
    const db = viewAsFetch(base, { header: true });

    await db(`${SUPA}/rest/v1/clients?select=id`);
    expect(seen[0].headers.get(VIEW_AS_HEADER)).toBe(PETER);

    const refused = await db(`${SUPA}/rest/v1/profiles?id=eq.${PETER}`, { method: "PATCH", body: "{}" });
    expect(refused.status).toBe(403);
    expect((await refused.json()).message).toBe("You're viewing as Peter Gonzalez: exit to make changes.");
    expect(seen).toHaveLength(1);
    // The page is told once, to show it
    expect(jar.has("kz_view_as_blocked")).toBe(true);

    const outside = viewAsFetch(base);
    await expect(outside("https://slack.com/api/chat.postMessage", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(ViewAsReadOnlyError);
    await expect(outside("https://api.resend.com/emails", { method: "POST", body: "{}" })).rejects.toThrow("You're viewing as Peter Gonzalez: exit to make changes.");
    expect(seen).toHaveLength(1);
    vi.unstubAllEnvs();
  });

  it("changes nothing for everyone else", async () => {
    const seen: Headers[] = [];
    const base = (async (_: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response("ok");
    }) as typeof fetch;
    const { viewAsFetch } = await import("@/lib/view-as-fetch");
    await viewAsFetch(base)("https://slack.com/api/chat.postMessage", { method: "POST" });
    await viewAsFetch(base, { header: true })(`${SUPA}/rest/v1/profiles`, { method: "PATCH" });
    expect(seen).toHaveLength(2);
    expect(seen.every((h) => !h.has(VIEW_AS_HEADER))).toBe(true);
  });

  it("an action's refusal reads as the usual { ok: false, error }", async () => {
    const { viewAsRefusal } = await import("@/lib/view-as");
    expect(await viewAsRefusal()).toBeNull();
    jar.set(VIEW_AS_COOKIE, formatViewAsCookie({ id: PETER, role: null, name: "Peter Gonzalez" }));
    expect(await viewAsRefusal()).toEqual({ ok: false, error: "You're viewing as Peter Gonzalez: exit to make changes." });
  });
});

describe("roles", () => {
  it("shows a role through the active teammate holding the most clients", () => {
    const people = [
      { id: "a", full_name: "Ann", role: "social_media_manager", is_active: true, clients: 3 },
      { id: "b", full_name: "Bo", role: "social_media_manager", is_active: true, clients: 7 },
      { id: "c", full_name: "Cy", role: "social_media_manager", is_active: false, clients: 9 },
    ];
    expect(representativeFor("social_media_manager", people)?.id).toBe("b");
    expect(representativeFor("head_of_email", people)).toBeNull();
  });

  it("describes what a role sees, the sidebar's way", () => {
    const sm = roleView("social_media_manager");
    expect(sm.places).toEqual(["Overview", "Clients", "KPIs", "Reports", "Kaizen AI", "Feedback"]);
    expect(sm.clients).toBe("Only the clients they're assigned to");
    expect(sm.paidAds).toBe(false);
    expect(roleView("head_of_social").clients).toMatch(/organic social/);
    expect(roleView("graphic_designer").places).not.toContain("KPIs");
    expect(roleView("executive").places).toContain("Settings");
  });
});
