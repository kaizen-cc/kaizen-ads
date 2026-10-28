/** Up to two initials from a name ("Kore Outdoor" -> "KO"), for avatars. Plain code, so server and browser both use it. */
export const initials = (name: string) =>
  name
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
