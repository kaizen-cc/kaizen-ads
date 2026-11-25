// Dates on the prospect page, written the same on the server and in the browser. Formatting without a fixed time zone
// gives the server's zone (UTC) in the HTML and the viewer's zone once React takes over, so the text differs and React
// throws a hydration error (#418). Kaizen runs on New York time, so both sides format there.

const TZ = "America/New_York";

const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" });
const stampFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** "Nov 25, 2026" */
export const prospectDay = (iso: string) => dayFmt.format(new Date(iso));

/** "Nov 25, 3:05 PM" */
export const prospectStamp = (iso: string) => stampFmt.format(new Date(iso));
