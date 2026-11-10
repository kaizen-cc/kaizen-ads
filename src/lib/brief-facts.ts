import type { BriefSpec, ClientFact } from "./brief-spec";

// Facts only the client knows. An ad that promises "the seat most fans miss" is built on WHICH seat and WHY: the AI
// can't know it and must never invent it. This finds the concepts that hang on such a fact (a reveal, a secret, a list
// of tips, a stat, an offer's terms, a date) from the words of the title, hook, insight and key message, and says what
// to ask. A fact the brief already answers (in "Confirm with client" with an answer, or an insight with its source) is
// covered. Pure: tested in tests/brief-facts.test.ts.

export type FactKind = "reveal" | "secret" | "list" | "stat" | "offer" | "date";
export type DetectedFact = { kind: FactKind; key: string; phrase: string; question: string };

const PLACE_NOUN = /^(seats?|sections?|rows?|spots?|tables?|booths?|views?|entrances?|gates?|parking)$/i;
const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const singular = (w: string) => (/ss$/i.test(w) ? w : w.replace(/s$/i, ""));

/** The question for a reveal about a noun ("seat" asks for the venue too) */
function revealQuestion(noun: string) {
  const n = singular(noun.toLowerCase().trim());
  const last = n.split(/\s+/).pop() ?? n;
  if (PLACE_NOUN.test(last)) return `Which ${n}, at which venue, and why?`;
  return `Which ${n} exactly, and why?`;
}

/**
 * The client-only facts a concept depends on, from its words. Conservative: only phrases that promise a specific,
 * checkable thing. One per kind and key.
 */
export function detectClientFacts(text: string): DetectedFact[] {
  const t = text.replace(/\s+/g, " ");
  const out: DetectedFact[] = [];
  const add = (f: DetectedFact) => {
    if (!out.some((x) => x.kind === f.kind && x.key === f.key)) out.push(f);
  };
  // "the seat most fans miss", "the one mistake nobody notices", "the dish everyone overlooks"
  for (const m of t.matchAll(/\bthe ((?:\w+ ){0,2}?\w+) (?:that )?(?:most|many|nobody|no one|few|everyone|everybody|every|all the|half the)(?: \w+){0,2}? (?:miss(?:es)?|overlook(?:s)?|forget(?:s)?|ignore(?:s)?|never (?:see|notice|know|try|ask)|don'?t (?:know|notice|see)|get wrong|skip(?:s)?)\b/gi)) {
    const noun = m[1].replace(/^(one|only|single|best|real|secret) /i, "");
    add({ kind: "reveal", key: singular(noun.toLowerCase()), phrase: m[0], question: revealQuestion(noun) });
  }
  // "the secret to", "hidden gem", "insider trick", "what nobody tells you about"
  for (const m of t.matchAll(/\b(?:secret|hidden|little[- ]known|insider|best[- ]kept) (\w+)/gi)) {
    if (/^(to|of|is|that|and|for)$/i.test(m[1])) {
      add({ kind: "secret", key: "secret", phrase: m[0], question: `What is the secret exactly, and how do we know it's true?` });
      continue;
    }
    add({ kind: "secret", key: singular(m[1].toLowerCase()), phrase: m[0], question: `What is the ${m[0].toLowerCase()} exactly, and how do we know it's true?` });
  }
  if (/\bwhat (?:nobody|no one|they don'?t) tells? you\b/i.test(t)) add({ kind: "secret", key: "secret", phrase: "what nobody tells you", question: "What is the thing nobody tells you, exactly?" });
  // "3 tips", "five mistakes", "the 7 reasons"
  for (const m of t.matchAll(/\b(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten) (tips?|tricks?|hacks?|mistakes?|reasons?|secrets?|signs?|rules?|steps?|things?)\b/gi)) {
    add({ kind: "list", key: m[2].toLowerCase().replace(/s$/, ""), phrase: m[0], question: `What are the ${m[1].toLowerCase()} ${m[2].toLowerCase()}, exactly? They come from the client.` });
  }
  // A number the ad states: 73%, 3x, 10,000 fans, #1
  for (const m of t.matchAll(/(?:\b\d{1,3}(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?x\b|\b\d{1,3}(?:,\d{3})+\+?|\b\d{3,}\+?(?= (?:customers|clients|fans|reviews|people|families|members|students|homes|patients))|#1\b|\bnumber one\b)/gi)) {
    add({ kind: "stat", key: m[0].toLowerCase(), phrase: m[0], question: `Where does "${m[0]}" come from? Confirm the number and its source with the client.` });
  }
  // The offer's terms
  for (const m of t.matchAll(/\b(?:\d{1,3}\s?% off|\$\d[\d,.]*(?: off)?|buy one,? get one|bogo|free (?:shipping|delivery|trial|gift|consultation|\w+ with)|promo code|limited[- ]time offer|today only)\b/gi)) {
    add({ kind: "offer", key: "offer", phrase: m[0], question: `What exactly is the offer (${m[0]}): the amount, the terms and the dates?` });
  }
  // A date the ad names
  for (const m of t.matchAll(new RegExp(`\\b(?:(?:${MONTHS})\\.? \\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)? (?:${MONTHS})|this (?:weekend|saturday|sunday|friday)|(?:ends|starts|until|through) (?:${MONTHS}|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\w*)\\b`, "gi"))) {
    add({ kind: "date", key: m[0].toLowerCase(), phrase: m[0], question: `Confirm "${m[0]}" with the client: is that date right, and what happens on it?` });
  }
  return out;
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9%$#]+/g, " ").split(" ").filter((w) => w.length > 2);

/** Does an answered fact (or the insight with its source) already settle this one? */
export function factCovered(f: DetectedFact, sp: Pick<BriefSpec, "confirm" | "insight" | "insightSource">) {
  const keyWords = words(f.key);
  const hits = (s: string) => {
    const w = new Set(words(s));
    return keyWords.length ? keyWords.every((k) => w.has(k) || w.has(`${k}s`)) : false;
  };
  if (sp.confirm.some((c) => c.answer.trim() && (hits(c.question) || hits(c.answer) || (f.kind === "offer" && /offer|terms|price|discount/i.test(c.question))))) return true;
  // A reveal, a secret or a list the insight spells out from the context, with its source
  if (sp.insightSource.trim() && ["reveal", "secret", "list"].includes(f.kind) && sp.insight.trim().length > 30) return true;
  return false;
}

/** The text a concept's facts are read from: its title, hook, insight and key message */
export const factText = (title: string, sp: Pick<BriefSpec, "hook" | "insight" | "keyMessage">) => [title, sp.hook, sp.insight, sp.keyMessage].filter(Boolean).join(". ");

/**
 * The spec with every detected fact it doesn't cover added to "Confirm with client" as a question (never an answer),
 * so the brief shows it for the maker to confirm (a heads-up that never holds the brief) until someone answers it.
 */
export function withDetectedFacts(sp: BriefSpec, title: string): BriefSpec {
  const found = detectClientFacts(factText(title, sp)).filter((f) => !factCovered(f, sp));
  const fresh = found.filter((f) => !sp.confirm.some((c) => words(c.question).join(" ") === words(f.question).join(" ") || (f.key && words(c.question).some((w) => words(f.key).includes(w) && w.length > 3))));
  if (!fresh.length) return sp;
  return { ...sp, confirm: [...sp.confirm, ...fresh.map((f) => ({ question: f.question, answer: "", source: "" }))] };
}

/** The questions still waiting on the client (or on whoever knows) */
export const openFacts = (sp: Pick<BriefSpec, "confirm">): ClientFact[] => sp.confirm.filter((c) => c.question.trim() && !c.answer.trim());

/** An answer given in the app: kept on the fact, with who it came from */
export function answerFact(sp: BriefSpec, question: string, answer: string, source: string): BriefSpec {
  const q = question.trim();
  const has = sp.confirm.some((c) => c.question.trim() === q);
  const confirm = has ? sp.confirm.map((c) => (c.question.trim() === q ? { ...c, answer: answer.trim(), source: source.trim() } : c)) : [...sp.confirm, { question: q, answer: answer.trim(), source: source.trim() }];
  return { ...sp, confirm };
}

/** The Brand Bible's open-question tag for a fact (offers to the offer route, the rest to creative) */
export const factCategory = (question: string): "offer" | "creative" | "business" => (/\boffer|price|discount|terms|promo|deal\b/i.test(question) ? "offer" : /\bdate|when\b/i.test(question) ? "business" : "creative");
