import { emailHtml, emailText } from "@/lib/email-layout";

/** The sign-in email a client receives. One button, no password. */
export function magicLinkEmail(params: { link: string; brandName?: string | null; firstName?: string | null }) {
  const where = params.brandName ? `${params.brandName} on Kaizen` : "your Kaizen portal";
  const parts = {
    preheader: "Your one-tap sign-in. It works once and expires in an hour.",
    kicker: params.brandName ?? "Kaizen",
    title: "Your sign-in link",
    hello: params.firstName ? `Hi ${params.firstName},` : "Hi there,",
    lines: [`Tap the button to sign in to ${where}. It works once and expires in 1 hour.`],
    cta: { label: "Sign in →", url: params.link },
    note: `If the button doesn't work, copy this link into your browser: ${params.link}. Didn't ask for this? You can ignore this email.`,
  };
  return { subject: `Your sign-in link for ${where}`, text: emailText(parts), html: emailHtml(parts) };
}
