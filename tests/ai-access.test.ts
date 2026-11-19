import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mayManagePeople, mayOpen, seesAccountNumbers, seesMoney } from "@/lib/ai-access-core";
import { keepVisible, maySeeClient, mayOpenPath, visibleClientIds } from "@/lib/ai-access";
import { mayTransferSeat } from "@/lib/seat-transfer-core";

// A stand-in for Supabase: each table's rows, filtered by eq/in like the real client. The person's own session (db)
// only holds the rows their access rules would return; the server's (admin) holds everything.
type Rows = Record<string, Record<string, unknown>[]>;
function fake(tables: Rows): SupabaseClient {
  const query = (rows: Record<string, unknown>[]) => {
    let out = [...rows];
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => ((out = out.filter((r) => r[k] === v)), q),
      in: (k: string, vs: unknown[]) => ((out = out.filter((r) => vs.includes(r[k]))), q),
      range: () => Promise.resolve({ data: out, error: null }),
      maybeSingle: () => Promise.resolve({ data: out[0] ?? null, error: null }),
      then: (ok: (v: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: out, error: null }).then(ok),
    };
    return q;
  };
  return { from: (t: string) => query(tables[t] ?? []) } as unknown as SupabaseClient;
}

const everything: Rows = {
  clients: [
    { id: "c1", slug: "limelight", archived_at: null, services: ["paid-ads", "creative"], services_extra: null, services_removed: null, strategy_only: null },
    { id: "c2", slug: "oceanbox", archived_at: null, services: ["paid-ads", "email-marketing"], services_extra: null, services_removed: null, strategy_only: null },
  ],
  client_assignments: [
    { client_id: "c1", profile_id: "designer" },
    { client_id: "c1", profile_id: "buyer" },
    { client_id: "c2", profile_id: "strategist" },
  ],
  ai_threads: [{ id: "t-mine" }],
  account_handoffs: [],
};
const admin = fake(everything);
// What each person's own session returns: their seated clients only
const sessionOf = (clients: string[]) => fake({ ...everything, clients: everything.clients.filter((c) => clients.includes(c.id as string)) });

const designer = { me: { id: "designer", role: "graphic_designer", isExec: false, isLead: false }, db: sessionOf(["c1"]), admin };
const buyer = { me: { id: "buyer", role: "media_buyer", isExec: false, isLead: false }, db: sessionOf(["c1"]), admin };
const emailStrategist = { me: { id: "strategist", role: "email_strategist", isExec: false, isLead: false }, db: sessionOf(["c2"]), admin };
const exec = { me: { id: "exec", role: "executive", isExec: true, isLead: false }, db: sessionOf(["c1", "c2"]), admin };

describe("client data: only what the person can see in the app", () => {
  it("a designer can't read another client, nor any account numbers", async () => {
    expect(await maySeeClient(designer, "c1")).toBe(true);
    expect(await maySeeClient(designer, "c2")).toBe(false);
    expect(seesAccountNumbers(designer.me)).toBe(false);
    expect(seesAccountNumbers(buyer.me)).toBe(true);
    expect(seesAccountNumbers(exec.me)).toBe(true);
  });

  it("a buyer can't read email data for a client they're not on", async () => {
    const emailRows = [
      { client_id: "c1", subject: "Limelight flow" },
      { client_id: "c2", subject: "OceanBox campaign" },
    ];
    expect((await keepVisible(buyer, emailRows)).map((r) => r.subject)).toEqual(["Limelight flow"]);
    expect(await maySeeClient(buyer, "c2")).toBe(false);
  });

  it("the email team sees only the clients they're seated on", async () => {
    expect([...(await visibleClientIds(emailStrategist))]).toEqual(["c2"]);
    expect(await maySeeClient(emailStrategist, "c1")).toBe(false);
  });

  it("an executive sees every client", async () => {
    expect([...(await visibleClientIds(exec))].sort()).toEqual(["c1", "c2"]);
  });
});

describe("pages: only what the person could open", () => {
  it("makers can't open Ideas, Winners or Market", () => {
    for (const href of ["/ideas", "/ideas/playbook/x", "/winners", "/market", "/pipeline?tab=ideas"]) expect(mayOpen(href, designer.me).ok).toBe(false);
    expect(mayOpen("/ideas", buyer.me).ok).toBe(true);
  });

  it("exec pages, Settings sections and account numbers follow the role", () => {
    expect(mayOpen("/csuite", buyer.me).ok).toBe(false);
    expect(mayOpen("/csuite", exec.me).ok).toBe(true);
    expect(mayOpen("/settings?tab=errors", buyer.me).ok).toBe(false);
    expect(mayOpen("/settings?tab=connections", buyer.me).ok).toBe(true);
    expect(mayOpen("/kpis/audit/abc", emailStrategist.me).ok).toBe(false);
    expect(mayOpen("/watch", designer.me).ok).toBe(false);
    expect(mayOpen("/board/email", designer.me).ok).toBe(false);
    expect(mayOpen("/team/handoffs", buyer.me).ok).toBe(false);
  });

  it("a client's page, someone else's Kaizen AI chat: refused with a reason", async () => {
    expect((await mayOpenPath(designer, "/clients/limelight")).ok).toBe(true);
    const other = await mayOpenPath(designer, "/clients/oceanbox?tab=email");
    expect(other).toEqual({ ok: false, why: expect.stringMatching(/isn't one you can see/) });
    expect((await mayOpenPath(designer, "/ai?t=t-mine")).ok).toBe(true);
    const stranger = { ...designer, db: fake({ ...everything, ai_threads: [] }) };
    expect(await mayOpenPath(stranger, "/ai?t=t-theirs")).toEqual({ ok: false, why: expect.stringMatching(/isn't yours or shared/) });
  });
});

describe("team, HR and money", () => {
  it("a lead can't move seats outside their line", () => {
    const headOfMeta = { role: "head_of_meta", isExec: false };
    expect(mayTransferSeat(headOfMeta, "meta_buyer")).toBe(true);
    expect(mayTransferSeat(headOfMeta, "email_strategist")).toBe(false);
    expect(mayTransferSeat(headOfMeta, "google_buyer")).toBe(false);
  });
  it("people and money are for executives (and heads, for their own people)", () => {
    expect(mayManagePeople(buyer.me).ok).toBe(false);
    expect(mayManagePeople({ role: "head_of_email" }).ok).toBe(true);
    expect(seesMoney({ role: "head_of_meta", isLead: true }).ok).toBe(false);
    expect(seesMoney(exec.me).ok).toBe(true);
  });
});
