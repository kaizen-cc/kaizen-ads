// Internal and sandbox clients (Kaizen's own test client, e.g. "Kaizen (sandbox)") never show on a lead's or an
// exec's lists: nothing there is a client to look after. Pure, by name and slug.

const INTERNAL = /\b(sandbox|test client|internal|demo)\b/i;

export function isInternalClient(name: string | null | undefined, slug?: string | null): boolean {
  return INTERNAL.test(String(name ?? "")) || INTERNAL.test(String(slug ?? "").replace(/-/g, " "));
}
