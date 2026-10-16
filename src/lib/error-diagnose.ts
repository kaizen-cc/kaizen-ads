import "server-only";

// Claude reads a real error (message, stack, page, who, how often) and explains it for the person
// who runs operations: what happened, the likely cause, how bad it is, and what would fix it.
export type Diagnosis = {
  summary: string;
  cause: string;
  impact: string;
  severity: "low" | "medium" | "high";
  dataRisk: boolean;
  fix: string;
  handled: string;
  by: "claude" | "rules";
};

const MODELS = ["claude-sonnet-5-5", "claude-haiku-5-5"];
const APP = `Kaizen Ads is the internal creative request and approval app of Kaizen Marketing (a paid social agency): Next.js 16
App Router on Vercel, Supabase Postgres with row-level security. Media buyers request ads, designers and editors upload creative,
the team reviews it, clients approve it in a portal, and it launches to Meta. AI agents (Claude) write briefs, copy and reviews;
background jobs sync Meta, Slack, Gmail, Drive, call notes and Motion.
Errors come from: "server" (server code), "page" (a page crashed or a script failed in the browser), "action" (a button or form's server action).`;

export async function diagnoseError(e: {
  message: string;
  path: string | null;
  kind: string;
  stack?: string | null;
  count: number;
  people: string[];
  userAgent?: string | null;
  version?: string | null;
}): Promise<Diagnosis | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const prompt = `${APP}

An error was recorded. Diagnose it for a non-technical owner. Be concrete and honest about uncertainty; don't invent code you can't see.

Error: ${e.message}
Where: ${e.path ?? "unknown"} (${e.kind})
Times seen: ${e.count}, people: ${e.people.length ? e.people.join(", ") : "unknown"}
Browser: ${e.userAgent ?? "unknown"}
App version: ${e.version ?? "unknown"}
Stack (may be minified):
${(e.stack ?? "none").slice(0, 3000)}`;

  for (const model of MODELS) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(25_000),
        body: JSON.stringify({
          model,
          max_tokens: 900,
          tools: [
            {
              name: "diagnosis",
              description: "Plain-language diagnosis of the error",
              input_schema: {
                type: "object",
                properties: {
                  summary: { type: "string", description: "What happened, one or two sentences, no jargon" },
                  cause: { type: "string", description: "The most likely reason, and how sure you are" },
                  impact: { type: "string", description: "What the person experienced; whether anything was lost" },
                  severity: { type: "string", enum: ["low", "medium", "high"] },
                  dataRisk: { type: "boolean", description: "Could requests, creative, approvals or client data be wrong or lost?" },
                  fix: { type: "string", description: "What would fix it (code change, data fix, or nothing needed)" },
                },
                required: ["summary", "cause", "impact", "severity", "dataRisk", "fix"],
              },
            },
          ],
          tool_choice: { type: "tool", name: "diagnosis" },
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        if (res.status === 400 || res.status === 404) continue;
        return null;
      }
      const json = (await res.json()) as { content: { type: string; input?: Omit<Diagnosis, "handled" | "by"> }[] };
      const out = json.content.find((c) => c.type === "tool_use")?.input;
      if (!out) return null;
      return {
        ...out,
        handled: "Recorded. The person saw a friendly error page with a Try again button; their work is safe.",
        by: "claude",
      };
    } catch {
      return null;
    }
  }
  return null;
}
