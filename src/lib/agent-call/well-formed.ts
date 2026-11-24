// Text sent to the model is cut in many places (an email's gist at 100 characters, a digest line at 140...). A cut that
// lands inside an emoji leaves half of it (a lone surrogate), and the API refuses the whole request ("no low surrogate
// in string"). That text sits in the person's context every turn, so every answer failed until it went away. Pure.

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** The text with any half of an emoji (a lone surrogate) replaced by "�" */
export function wellFormedText(s: string): string {
  return s.replace(LONE, "�");
}

/** Every string in a request (messages, system blocks, tool results) made well formed; other values left as they are */
export function wellFormed<T>(value: T): T {
  if (typeof value === "string") return wellFormedText(value) as T;
  if (Array.isArray(value)) return value.map((v) => wellFormed(v)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = wellFormed(v);
    return out as T;
  }
  return value;
}
