import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every AI call goes through one of the agents the team configures and trains (its skills, playbook, knowledge and
// learnings), and every call about one client carries that client (clientId), so the client's own lessons come with
// it. A static scan of the source, like the agent-moments test: a new call can't ship without its agent and client.
// Calls that run without a client (batches across many clients, cross-client patterns) or as a plain utility (sorting,
// classifying, extracting, `bare`) are listed below, each with why.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const files = (dir: string): string[] =>
  readdirSync(join(process.cwd(), dir)).flatMap((f) => {
    const p = `${dir}/${f}`;
    return statSync(join(process.cwd(), p)).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });

/** Comments blanked out (same length, so positions hold), strings and templates kept. */
function stripComments(s: string) {
  let out = "";
  let i = 0;
  const stack: string[] = []; // open string/template quotes, and "{" for a ${ } inside a template
  while (i < s.length) {
    const c = s[i];
    const top = stack[stack.length - 1];
    if (top === '"' || top === "'") {
      if (c === "\\") {
        out += s.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === top || c === "\n") stack.pop();
      out += c;
      i++;
      continue;
    }
    if (top === "`") {
      if (c === "\\") {
        out += s.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") stack.pop();
      else if (c === "$" && s[i + 1] === "{") {
        stack.push("{");
        out += "${";
        i += 2;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    // code (top level or inside ${ })
    if (c === "/" && s[i + 1] === "/") {
      const end = s.indexOf("\n", i);
      const stop = end === -1 ? s.length : end;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      const stop = end === -1 ? s.length : end + 2;
      out += s.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    // A regex literal (after an operator or an opening bracket): its body blanked too, so a quote in it can't open a string
    if (c === "/" && /(^|[(,=:[!&|?{};]|\breturn)\s*$/.test(out.slice(-12))) {
      let j = i + 1;
      let inClass = false;
      for (; j < s.length && s[j] !== "\n"; j++) {
        if (s[j] === "\\") j++;
        else if (s[j] === "[") inClass = true;
        else if (s[j] === "]") inClass = false;
        else if (s[j] === "/" && !inClass) break;
      }
      if (s[j] === "/") {
        out += `/${" ".repeat(j - i - 1)}/`;
        i = j + 1;
        continue;
      }
    }
    if (c === '"' || c === "'" || c === "`") stack.push(c);
    else if (c === "{") stack.push("{");
    else if (c === "}" && top === "{") stack.pop();
    out += c;
    i++;
  }
  return out;
}

/** The index of the brace closing the one at `open`, in comment-free source. */
function closing(s: string, open: number) {
  // One stack: open quotes, code braces ("{") and template expressions ("${")
  const stack: string[] = [];
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    const top = stack[stack.length - 1];
    if (top === '"' || top === "'" || top === "`") {
      if (c === "\\") i++;
      else if (c === top || (c === "\n" && top !== "`")) stack.pop();
      else if (top === "`" && c === "$" && s[i + 1] === "{") {
        stack.push("${");
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") stack.push(c);
    else if (c === "{") stack.push("{");
    else if (c === "}") {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

type Site = { file: string; line: number; fn: string; agent: string | null; label: string; body: string; before: string };

function sites(): Site[] {
  const out: Site[] = [];
  for (const file of files("src")) {
    const raw = read(file);
    if (!/askJson/.test(raw)) continue;
    const src = stripComments(raw);
    for (const m of src.matchAll(/\b(askJsonWithTools|askJson)\b/g)) {
      const at = m.index!;
      const lineStart = src.lastIndexOf("\n", at) + 1;
      const lineText = src.slice(lineStart, src.indexOf("\n", at));
      if (/function\s+askJson|typeof\s+askJson|import\b/.test(lineText.slice(0, at - lineStart + m[1].length + 1))) continue;
      let i = at + m[1].length;
      // A generic argument, if any: skip to its matching >
      if (src[i] === "<") {
        let depth = 0;
        for (; i < src.length; i++) {
          if (src[i] === "<") depth++;
          else if (src[i] === ">" && src[i - 1] !== "=") {
            depth--;
            if (depth === 0) break;
          }
        }
        i++;
      }
      while (/\s/.test(src[i])) i++;
      if (src[i] !== "(") continue;
      i++;
      while (/\s/.test(src[i])) i++;
      if (src[i] !== "{") continue;
      const end = closing(src, i);
      const body = src.slice(i, end + 1);
      // agent: "x", or passed through (the shorthand `agent,` or a wrapper's ...opts)
      const agent = body.match(/\bagent:\s*([^,\n]+)/)?.[1]?.trim() ?? (/[{,]\s*agent\s*[,}]/.test(body) || /\.\.\.opts\b/.test(body) ? "(passed through)" : null);
      const label = body.match(/\blabel:\s*[`"']([^`"'$]*)/)?.[1]?.trim() ?? "";
      // The enclosing top-level function, from its signature to the call (or the 2500 characters before it)
      const head = [...src.slice(0, at).matchAll(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b|^(?:export\s+)?const\s+\w+\s*=\s*async\b/gm)].pop();
      const before = src.slice(head ? head.index! : Math.max(0, at - 2500), at);
      out.push({ file, line: src.slice(0, at).split("\n").length, fn: m[1], agent, label, body, before });
    }
  }
  return out;
}

// file → label prefixes allowed without a clientId (or with bare). Each is a utility, a batch over many clients, or
// cross-client work where no single client is the subject.
const UTILITY: Record<string, { labels: string[]; why: string }> = {
  "src/lib/agent-evals.ts": { labels: ["agent eval"], why: "the evals run the agent bare on purpose, to test its own config" },
  "src/lib/ai-router.ts": { labels: [""], why: "routes a message to a model level; a classifier" },
  "src/lib/asana.ts": { labels: ["asana allotment count"], why: "counts units across many tickets at once" },
  "src/lib/bible-links.ts": { labels: ["bible link check"], why: "compares two versions of a web page; a diff" },
  "src/lib/bible-rules.ts": { labels: ["bible rules log"], why: "extracts dos and don'ts from statements; extraction" },
  "src/lib/business-audit-route.ts": { labels: ["sprint merge"], why: "merges two action lists; a utility" },
  "src/lib/buying-insights.ts": { labels: ["insight industry map", "insight scope"], why: "places industry names in the taxonomy and sorts the senior buyer's points in batches across videos; classification" },
  "src/lib/calls.ts": { labels: ["commitments covered", "recheck call promises"], why: "classifies promises against tickets, in batches" },
  "src/lib/chat-changes.ts": { labels: ["chat team change"], why: "maps a request to a seat and a person from a list" },
  "src/lib/client-docs.ts": { labels: ["client document"], why: "summarises one file; extraction" },
  "src/lib/creative-errors.ts": { labels: ["creative error check"], why: "classifies review feedback across all clients" },
  "src/lib/feedback.ts": { labels: ["feedback triage"], why: "classifies the team's feedback about the app and matches repeats; no client is the subject" },
  "src/lib/google-playbooks.ts": { labels: ["google playbook"], why: "cross-client playbook per sub-vertical" },
  "src/lib/industry.ts": { labels: ["client industries"], why: "classifies many clients at once" },
  "src/lib/keyword-research.ts": { labels: ["keyword relevance"], why: "sorts keyword ideas into groups" },
  "src/lib/knowledge.ts": { labels: ["read a knowledge pdf"], why: "reads a knowledge file; extraction" },
  "src/lib/lab.ts": { labels: ["lab deploy"], why: "an Ads Lab test spans several clients" },
  "src/lib/launcher.ts": { labels: ["launch rules pattern"], why: "a pattern across clients' launch rules" },
  "src/lib/learnings.ts": { labels: ["learning scope", "learning consolidate"], why: "files and merges the agents' own learnings" },
  "src/lib/ledger.ts": { labels: ["playbook angles", "playbook learnings"], why: "labels ledger rows; extraction" },
  "src/lib/lesson-sharing.ts": { labels: ["share lesson"], why: "decides which other clients a lesson fits" },
  "src/lib/market.ts": { labels: ["brands to watch", "check market brands", "describe market brands"], why: "market brands across all clients" },
  "src/lib/message-promises.ts": { labels: ["promises in messages", "promise follow-through", "promise client match"], why: "extracts and checks promises in batches, and matches them to clients across the whole client list" },
  "src/lib/owed-replies.ts": { labels: ["owed replies"], why: "classifies which messages wait on a reply, in batches" },
  "src/lib/patterns.ts": { labels: ["cross-client patterns"], why: "patterns across a business model, unnamed" },
  "src/lib/playbooks.ts": { labels: ["playbook"], why: "cross-client playbook per sub-vertical" },
  "src/lib/promise-groups.ts": { labels: ["group promises"], why: "groups duplicate promises; a utility" },
  "src/lib/website-issues.ts": { labels: ["website issues"], why: "reads a page check's findings; extraction" },
  "src/lib/context/docs.ts": { labels: ["read a doc"], why: "reads Drive docs for every client in one pass" },
  "src/lib/reports/builder.ts": { labels: ["joint report message"], why: "joins report messages already written with the client's context" },
};

const allowed = (s: Site) => UTILITY[s.file]?.labels.some((l) => (l === "" ? true : s.label.startsWith(l))) ?? false;
const where = (s: Site) => `${s.file}:${s.line} (${s.label || s.fn})`;

describe("every AI call uses a trained agent and its client", () => {
  const all = sites();
  const union = read("src/lib/ai.ts").match(/export type AgentKey = ([^;]+);/)?.[1] ?? "";
  const keys = new Set([...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));

  it("finds the calls", () => {
    expect(all.length).toBeGreaterThan(80);
    expect(all.some((s) => s.fn === "askJsonWithTools")).toBe(true);
  });

  it("names a real agent on every call", () => {
    const bad = all.filter((s) => {
      if (!s.agent) return true;
      // The agent names in it (not the values it compares against, as in step === "google" ? "google_launcher" : "launcher")
      const literal = [...s.agent.matchAll(/(?<![=!]==\s*)"([a-z_]+)"/g)].map((m) => m[1]);
      return literal.some((a) => !keys.has(a));
    });
    expect(bad.map(where), "calls with no agent, or an agent that isn't configured in src/lib/ai.ts").toEqual([]);
  });

  it("runs bare (without the agent's skills) only for listed utilities", () => {
    const bad = all.filter((s) => /\bbare(\s*:\s*true)?\s*[,}]/.test(s.body) && !/bare:\s*false/.test(s.body) && !allowed(s));
    expect(bad.map(where), "bare calls that aren't listed as utilities in tests/ai-call-sites.test.ts").toEqual([]);
  });

  it("passes the client on every call about a client", () => {
    const bad = all.filter((s) => {
      const aboutClient = /\bclientId\b|client_id|client\.id/.test(s.before + s.body);
      const passes = /\bclientId\b\s*[:,}]/.test(s.body);
      return aboutClient && !passes && !allowed(s);
    });
    expect(bad.map(where), "client calls without clientId (pass it, or list the call as a utility with why)").toEqual([]);
  });

  it("keeps the utility list current", () => {
    const stale = Object.entries(UTILITY).flatMap(([file, { labels }]) => labels.filter((l) => !all.some((s) => s.file === file && (l === "" || s.label.startsWith(l)))).map((l) => `${file}: "${l}"`));
    expect(stale, "utility entries that no longer match a call").toEqual([]);
  });
});
