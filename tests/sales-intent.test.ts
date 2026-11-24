import { describe, expect, it } from "vitest";
import { clientIn, domainsIn, maybeSales, salesIntent } from "@/lib/assistant/sales-intent";
import { directSpecialist } from "@/lib/assistant/team";

const exec = { role: "coo", isExec: true, isLead: false };
const head = { role: "head_of_email", isExec: false, isLead: true };
const buyer = { role: "media_buyer", isExec: false, isLead: false };
const clients = [
  { name: "Crust Pizza Co", website: "https://crustpizza.com" },
  { name: "Angry Chickz", website: "angrychickz.com" },
  { name: "Ocean Box", website: null },
];

// The routing the turn does: the intent (with the client list) into directSpecialist
const route = (text: string, me = exec, opts: { onClient?: boolean; screen?: string } = {}) => directSpecialist(text, { me, screen: opts.screen ?? null, sales: salesIntent(text, me, clients, { onClient: opts.onClient }) })?.key ?? null;

describe("sales intent: the owner's asks go to the Sales agent (typed in chat)", () => {
  const asks = [
    "Research this business: glowaestheticstampa.com",
    "Can you research this company for me? Bayshore Body Contouring in Tampa",
    "Scrub their website and tell me what they're missing: https://www.bayshorebody.com",
    "Look at their website, lux-skin-studio.com",
    "https://www.glowaestheticstampa.com/",
    "glowaestheticstampa.com what do you think?",
    "This is a potential client, what should we know before the call?",
    "I've got a prospect in Miami, a roofing company. Where do we start?",
    "How would we pitch Tampa Bay Smiles?",
    "What would Kaizen do for a two-location med spa like Glow?",
    "Find me businesses like Glow Aesthetics in Orlando",
    "Find me 10 med spas in Tampa running no ads",
    "I want to go after this account: Sunshine Pools",
    "Give me a sales strategy for Sunshine Pools",
    "Review this discovery call transcript with Sunshine Pools and tell me the next steps",
    "Draft the follow-ups from my discovery call with Bayshore Body",
    "Write a LinkedIn message for the owner of Glow",
  ];
  for (const a of asks)
    it(a, () => {
      expect(salesIntent(a, exec, clients).sales, a).toBe(true);
      expect(route(a)).toBe("sales");
    });
});

describe("sales intent: the same asks spoken on a call", () => {
  const spoken = [
    "hey can you research this business for me it's called glow aesthetics",
    "go look at their website glow aesthetics tampa dot com",
    "so this is a potential client and I want to know how we'd pitch them",
    "what would kaizen do for sunshine pools",
    "find me some roofing companies in dallas that aren't running ads",
    "I just got off a discovery call with bayshore body can you help me with the follow ups",
    "how should we approach this prospect",
  ];
  for (const a of spoken)
    it(a, () => {
      expect(route(a, head)).toBe("sales");
    });
});

describe("sales intent: what stays with the line specialists or the assistant", () => {
  it("a current client's website stays with the line specialists", () => {
    expect(salesIntent("look at their website crustpizza.com, why is the conversion rate down?", exec, clients).sales).toBe(false);
    expect(salesIntent("https://angrychickz.com", exec, clients).sales).toBe(false);
  });
  it("a current client named in a strategy ask is not a sales ask", () => {
    expect(salesIntent("how would we pitch a new offer to Crust Pizza Co's customers?", exec, clients).sales).toBe(false);
  });
  it("upsell or new business with a current client is Sales", () => {
    const r = salesIntent("How do we upsell Crust Pizza Co on email?", exec, clients);
    expect(r.sales).toBe(true);
    expect(r.about).toBe("Crust Pizza Co");
  });
  it("on a client's page, 'research this business' is about that client", () => {
    expect(route("research this business and tell me what to test", exec, { onClient: true })).not.toBe("sales");
    // ...but a prospect named outright still goes to Sales
    expect(route("I have a prospect who looks like this client, how would we pitch them?", exec, { onClient: true })).toBe("sales");
  });
  it("only execs and line heads: everyone else gets the assistant's own answer", () => {
    expect(salesIntent("Research this business: glowaestheticstampa.com", buyer, clients).sales).toBe(false);
    expect(route("Research this business: glowaestheticstampa.com", buyer)).toBeNull();
  });
  it("ordinary asks aren't sales", () => {
    for (const a of ["what's on my plate today?", "remind me to call the prospect at 3", "why is Meta CPA up for Angry Chickz?", "open the Email Board", "send Kyle the report"]) expect(salesIntent(a, exec, clients).sales, a).toBe(false);
    expect(route("why is the Meta CPA so high for Angry Chickz?")).toBe("media_buyer");
  });
  it("naming another specialist still wins", () => {
    expect(route("call in the email strategist about this prospect")).toBe("email_strategist");
  });
});

describe("sales intent: domains and clients", () => {
  it("finds domains, not emails or tool links", () => {
    expect(domainsIn("see https://www.Glow-Spa.com/about and sunshinepools.net")).toEqual(["glow-spa.com", "sunshinepools.net"]);
    expect(domainsIn("email me at santi@kaizenmarketing.agency")).toEqual([]);
    expect(salesIntent("https://docs.google.com/document/d/abc", exec, clients).sales).toBe(false);
  });
  it("matches a client by site or full name", () => {
    expect(clientIn("check www.crustpizza.com/menu", clients)?.name).toBe("Crust Pizza Co");
    expect(clientIn("the angry chickz team", clients)?.name).toBe("Angry Chickz");
    expect(clientIn("a pizza place", clients)).toBeNull();
  });
  it("the cheap first look", () => {
    expect(maybeSales("glow.com")).toBe(true);
    expect(maybeSales("what's on my plate")).toBe(false);
  });
});
