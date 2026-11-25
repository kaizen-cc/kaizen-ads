// A campaign's day in the report: the account's own (the loader sets sendDay in the Klaviyo account's time zone, the
// same days the sync rolls revenue up by), else Eastern as before. Plain, so every part of the report dates alike.

const etDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : "");

export const campaignDay = (c: { sendTime: string | null; sendDay?: string | null }) => c.sendDay || etDay(c.sendTime);
