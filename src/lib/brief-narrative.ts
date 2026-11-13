// The narrative QA pass: does the story work, not just the operational detail. From the lead strategist's notes on a
// video brief that needed six rounds: a hook whose answer arrived at 6 to 14 seconds, versions that didn't match the
// body, the strongest visual spent in the first seconds, critical claims not flagged, and a first strategic pass so
// generic a competitor's logo would have worked the same. These are the checks code can make (the AI review pass in
// src/lib/suggestions.ts and the brief check judge the rest: segment fit, whether a version's hook fits its body, the
// competitor swap test itself), the same for video, single image and carousel where they apply. Every finding is a
// flag with a fix the writer (or the revise chat) carries out, never a block. Pure: tested in tests/brief-narrative.test.ts.

import { versionLines } from "./brief-derive";
import { detectClientFacts } from "./brief-facts";
import { beatRows, beatSpan, frameOf, hookOf, openingOf, parseBrief, slideRows, type Beat } from "./brief-spec";

export type NarrativeIssue = { id: string; severity: "soft"; message: string; fixes: { kind: "ai"; instruction: string; label: string }[] };

export type NarrativeInput = {
  text: string;
  title?: string;
  formats: string[];
  /** The request's own lines (the intake): an idea that only restates them is generic */
  angle?: string | null;
  audience?: string | null;
  /** The client's name (it's not proof: a competitor's name swaps in for it) */
  client?: string | null;
  /** Versions and a carousel's slides the request asks for */
  versionsAsked?: number | null;
  slidesAsked?: number | null;
};

const issue = (id: string, message: string, instruction: string, label: string): NarrativeIssue => ({ id, severity: "soft", message, fixes: [{ kind: "ai", instruction, label }] });

/** A line that asks or teases: it owes the viewer an answer */
const TEASE = /\?["”']?\s*$|\b(?:why|how come|what (?:if|makes|most)|which|the (?:one|detail|secret|reason|trick|mistake|thing)|most (?:people|fans|buyers|customers) (?:miss|skip|don'?t|never|get wrong)|nobody|no one tells|here'?s (?:why|how|the)|guess|wait (?:for|till|until)|you won'?t believe)\b/i;
/** A beat or slide that pays the hook off */
const ANSWER = /\b(?:answer|reveal|payoff|pay-off|the turn|the point|solution|result|the detail|the secret|the trick|the one|why)\b/i;
/** A beat that carries the strongest visual: the reveal, the result, the hero shot */
const STRONGEST = /\b(?:reveal|result|transformation|before and after|after shot|hero shot|money shot|wow|final look|the big|best shot|payoff)\b/i;
const HOOKISH = /\b(?:hook|opener|open|cold open|problem|question|myth|context|story|tease)\b/i;
const CTA_JOB = /\b(?:cta|close|offer|end card|call to action|book|shop)\b/i;
const ACTION = /\b(?:shop|book|get|find|see|try|order|call|visit|claim|start|join|learn|sign up|download|grab|reserve|buy|save|apply|tap|swipe up|message us|dm us)\b/i;
const WEAK_FIRST = /^\s*(?:the\s+)?(?:logo|button|cta|price|disclaimer|fine print|url|website|brand name)\b/i;

const NUMBER = /(?:\$\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:%|x\b|k\b|\+)?)/gi;
const STOP = new Set(["the", "and", "for", "with", "that", "this", "your", "you", "our", "are", "was", "from", "they", "their", "what", "when", "who", "how", "why", "not", "but", "all", "can", "get", "its", "it's", "one", "more", "most", "than", "just", "into", "out", "about", "will", "has", "have", "who's", "them", "it", "a", "an", "of", "to", "in", "on", "is", "be", "at", "by", "or", "as"]);
const words = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? []).filter((w) => !STOP.has(w)));
const startOf = (b: Beat) => beatSpan(b.time)?.[0] ?? null;
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;

/** Names in the middle of a sentence ("Section 112", "Madison Square Garden"), the client's own name left out */
function properNouns(text: string, client?: string | null) {
  const own = words(client ?? "");
  const out = new Set<string>();
  for (const s of text.split(/(?<=[.!?:;])\s+|\n+/)) {
    const ws = s.trim().split(/\s+/).slice(1);
    for (const w of ws) {
      const m = /^[“"‘'(]?([A-Z][a-zA-Z]{2,})/.exec(w);
      if (m && !own.has(m[1].toLowerCase()) && !/^(?:Source|Says|Text|Hook|Shows|Headline|The|And|But|For|With|This|That|Our|Your|Kaizen|Drive|Must|Never|Brand|Bible|Meta|Reels|Stories)$/.test(m[1])) out.add(m[1]);
    }
  }
  return out;
}

export function narrativeIssues(i: NarrativeInput): NarrativeIssue[] {
  const p = parseBrief(i.text);
  const sp = p.spec;
  // Only a brief written in today's sections: an older or free-text one isn't held to a build it never had
  if (!p.structured) return [];
  const out: NarrativeIssue[] = [];
  const video = i.formats.includes("video");
  const image = i.formats.includes("image");
  const carousel = i.formats.includes("carousel");
  const idea = openingOf(p.overview).idea;
  const beats = beatRows(sp);
  const slides = slideRows(sp);
  const frame = frameOf(sp.frame);
  const versions = versionLines(sp.versions.filter(Boolean));
  const body = [idea, sp.insight, sp.keyMessage, ...sp.proof, ...beats.flatMap((b) => [b.onScreen, b.text, b.says]), ...slides.flatMap((s) => [s.headline, s.shows]), frame.headline, frame.subline, frame.shows, ...sp.copy, ...sp.dos, ...sp.confirm.map((c) => `${c.question} ${c.answer}`)].join("\n");

  // ── Video: the hook answered in the first ~3 seconds; the strongest visual not spent at the start ──
  if (video && beats.length >= 2) {
    const hookBeat = beats[0];
    const hookLine = hookBeat.text || hookBeat.says || hookOf(sp);
    const hookAll = [hookBeat.text, hookBeat.says].filter(Boolean).join(" ");
    // A question the hook beat answers itself ("Why buy from us?" "Convenience.", or a teasing line on screen with the
    // answer said under it) is answered in time
    const answeredInHook = /\?["”']?\s+\S/.test(hookAll) || Boolean(hookBeat.text && hookBeat.says && !TEASE.test(hookBeat.says));
    if (hookLine && TEASE.test(hookLine) && !answeredInHook) {
      const answer = beats.slice(1).find((b) => ANSWER.test(`${b.name} ${b.text}`)) ?? beats[1];
      const at = startOf(answer);
      if (at != null && at > 3.5)
        out.push(
          issue(
            "hook-answer-late",
            `The hook asks "${hookLine}" but the answer only comes at ${clock(at)} ("${answer.name || "the next beat"}"). Answer it within the first 3 seconds.`,
            `The video's hook ("${hookLine}") is answered too late: the answer arrives at ${clock(at)}. Restructure the beats so the hook's question or promise is answered within the first 3 seconds (answer in the hook beat or move the answer beat to 0:02-0:05), then spend the rest earning the click. Keep every exact line and source. Change nothing else.`,
            "Answer the hook in 3s",
          ),
        );
    }
    const strong = beats.map((b, k) => ({ b, k, at: startOf(b) })).filter(({ b }) => STRONGEST.test(`${b.name} ${b.onScreen}`));
    if (strong.length && strong.every(({ k, at }) => k >= 1 && at != null && at < 4) && beats.length >= 4)
      out.push(
        issue(
          "strongest-early",
          `The strongest visual ("${strong[0].b.name || strong[0].b.onScreen}") is spent at ${clock(strong[0].at!)}, right after the hook, and nothing later tops it.`,
          `The strongest visual ("${strong[0].b.name || strong[0].b.onScreen}") is spent in the first seconds without being the hook. Either make it the hook itself, or hold it for the payoff beat later in the video so the viewer has a reason to keep watching. Keep every exact line. Change nothing else.`,
          "Place the strongest visual",
        ),
      );
  }

  // ── Single image: the headline answers the hook at a glance; the strongest visual reads first ──
  if (image) {
    const head = frame.headline || versions[0]?.line || "";
    if (head && /\?["”']?\s*$/.test(head.trim()) && !frame.subline.trim())
      out.push(
        issue(
          "headline-open",
          `The headline asks "${head}" and nothing on the image answers it: a static gets one glance.`,
          `The single image's headline ("${head}") asks a question the image never answers. Answer it at a glance: add the answer as the Subline, or make the headline the answer itself. Change nothing else.`,
          "Answer it on the image",
        ),
      );
    if (frame.readsFirst && WEAK_FIRST.test(frame.readsFirst))
      out.push(
        issue(
          "reads-first",
          `Reads first starts with "${frame.readsFirst.split(/[,;.]/)[0].trim()}": the strongest visual or the headline should lead, never the logo or the button.`,
          `In the Frame, "Reads first" leads with the logo, the button or the fine print. Make the eye land on the strongest visual or the headline first, then the proof, then the button. Change nothing else.`,
          "Lead with the strongest visual",
        ),
      );
  }

  // ── Carousel: the first slide hooks, the order builds, the last asks for the click ──
  if (carousel && slides.length >= 2) {
    const first = slides[0];
    const last = slides[slides.length - 1];
    const firstJob = first.job || "";
    if (!first.headline.trim() || (firstJob && !HOOKISH.test(firstJob)) || /^\s*(?:swipe|learn more|shop now|introducing|meet)\b/i.test(first.headline))
      out.push(
        issue(
          "slide1-hook",
          `Slide 1 ${first.headline ? `("${first.headline}")` : ""} doesn't hook on its own${firstJob && !HOOKISH.test(firstJob) ? `: it's the ${firstJob.toLowerCase()}` : ""}.`.replace(/\s+/g, " "),
          "The carousel's first slide must stop the scroll on its own: give it a hook headline (a question, a surprising fact from the context, the problem) and move what it held later in the flow. Change nothing else.",
          "Hook on slide 1",
        ),
      );
    const ctaAt = slides.findIndex((s) => CTA_JOB.test(s.job));
    if (ctaAt >= 0 && ctaAt < slides.length - 1)
      out.push(issue("slide-order", `The call to action is slide ${ctaAt + 1} of ${slides.length}: the order should build to it, last.`, "Reorder the carousel's slides so they build: hook first, then the problem or proof, then the payoff, and the call to action last. Keep every headline. Change nothing else.", "Build to the CTA"));
    else if (slides.length >= 3 && /\b(?:payoff|reveal|result)\b/i.test(slides[0].job) )
      out.push(issue("slide-order", "The payoff is the first slide: there's nothing left to swipe for.", "Reorder the carousel's slides so the payoff comes after the hook and the proof, and the call to action is last. Keep every headline. Change nothing else.", "Build to the payoff"));
    if (!CTA_JOB.test(last.job) && !ACTION.test(last.headline))
      out.push(issue("last-cta", `The last slide ("${last.headline || last.job || "slide " + slides.length}") doesn't ask for the click.`, "Make the carousel's last slide ask for the click: a CTA headline with the action (Book, Shop, Get, Find...) and the button. Change nothing else.", "End on the CTA"));
    if (i.slidesAsked && slides.length < i.slidesAsked)
      out.push(issue("slides-short", `${i.slidesAsked} slides asked for, ${slides.length} written.`, `Write all ${i.slidesAsked} slides of the carousel, read top to bottom as a flow (hook first, CTA last). Change nothing else.`, "Write every slide"));
  }

  // ── Every format: versions match the body; claims the ad states are sourced or flagged ──
  if (i.versionsAsked && versions.length && versions.length < i.versionsAsked)
    out.push(issue("versions-short", `${i.versionsAsked} versions asked for, ${versions.length} written.`, `Write all ${i.versionsAsked} versions under Versions, V1 net new, each changing only its line (or saying what else changes with "| Also changes:"). Change nothing else.`, "Write every version"));
  for (const v of versions) {
    const k = sp.versions.filter(Boolean).findIndex((x) => x.includes(v.line));
    for (const m of v.line.matchAll(NUMBER)) {
      const n = m[0].trim().replace(/[.,]+$/, "");
      if (!/\d/.test(n) || /^\d$/.test(n) || /^V?\d{1,2}$/i.test(n)) continue;
      if (!body.includes(n)) {
        out.push(
          issue(
            `version-claim-${k + 1}`,
            `V${k + 1} says "${n}" but nothing in the body shows it or says where it comes from.`,
            `V${k + 1}'s line states "${n}", which the body never shows or sources. Either make the body carry it (with its source from the context), or change V${k + 1}'s line to something the body delivers. If it's a client fact, add it under Confirm with client as "Blocker: ...". Change nothing else.`,
            "Match the version to the body",
          ),
        );
        break;
      }
    }
  }
  const claimText = [...versions.map((v) => v.line), ...beats.flatMap((b) => [b.text, b.says]), ...slides.map((s) => s.headline), frame.headline, frame.subline, ...sp.copy].join(". ");
  const asked = sp.confirm.map((c) => `${c.question} ${c.answer}`.toLowerCase()).join(" ");
  const sourced = sp.insightSource.trim() ? sp.insight.toLowerCase() : "";
  for (const f of detectClientFacts(claimText).filter((f) => f.kind === "stat" || f.kind === "offer")) {
    const ph = f.phrase.toLowerCase();
    if (asked.includes(ph) || sourced.includes(ph) || (f.kind === "offer" && /\boffer|terms|discount|price\b/.test(asked))) continue;
    out.push(
      issue(
        `claim-${f.kind}-${ph.replace(/[^a-z0-9]+/g, "")}`,
        `The ad says "${f.phrase}" but nothing sources it or lists it to confirm: a claim the ad can't run without.`,
        `The brief states "${f.phrase}" on the creative without a source. Give its source from the context in Why it works, or add under Confirm with client: "- Blocker: ${f.question}". Never invent it. Change nothing else.`,
        "Flag the claim",
      ),
    );
  }

  // ── Differentiation: client-specific proof, and the intake not restated as the idea ──
  const concept = [idea, sp.insight, ...versions.map((v) => v.line)].join(". ");
  const hasNumber = /\d/.test(concept.replace(/\b(?:V\d{1,2}|\d{1,2}:\d{2}|\d+s)\b/gi, ""));
  const named = properNouns([idea, sp.insight, ...beats.map((b) => b.says), ...slides.map((s) => s.headline)].join(". "), i.client);
  const quoted = beats.some((b) => b.says && b.source);
  if (idea || sp.insight) {
    const signals = [hasNumber, named.size > 0, quoted, Boolean(sp.insightSource.trim())].filter(Boolean).length;
    if (signals < 2)
      out.push(
        issue(
          "generic-concept",
          "The concept is generic: put a competitor's logo on it and it works the same. It needs this client's own proof (their numbers, customers, offer, mechanism, reviews or best ads).",
          "Run the competitor swap test on this brief: with a competitor's logo, would it still work? It would, so rewrite the idea and Why it works once with this client's own proof from the context (a number, a named customer outcome, how their product really works, a review or the owner's words, what made their best ads work) and give its source. Keep the format, the versions' count and everything that's already specific. Never invent proof: if the context holds none, say what to get under Confirm with client.",
          "Make it theirs",
        ),
      );
    const intake = words([i.angle ?? "", i.audience ?? "", i.title ?? ""].join(" "));
    const own = [...words(idea)];
    if (intake.size >= 4 && own.length >= 5 && own.filter((w) => intake.has(w)).length / own.length >= 0.7)
      out.push(
        issue(
          "restates-intake",
          "The idea restates the request's angle and audience instead of saying what this ad shows that only this client can.",
          "The opening idea only restates the request's angle and audience. Rewrite that one sentence as the concrete idea and its payoff, built on this client's own proof from the context. Change nothing else.",
          "Sharpen the idea",
        ),
      );
  }
  return out;
}
