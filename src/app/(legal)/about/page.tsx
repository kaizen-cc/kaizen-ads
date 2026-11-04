import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Kaizen Ads by Kaizen Marketing", description: "The platform Kaizen Marketing runs its clients' advertising on: creative, approvals, reporting and account management for Meta and Google Ads." };

const FEATURES = [
  { title: "Creative requests and approvals", body: "Our team briefs, makes and reviews ads, and clients approve them in their own portal before anything runs." },
  { title: "Reporting and dashboards", body: "Clients see how their Meta and Google Ads campaigns perform against the goals we agreed, in plain language." },
  { title: "Account audits and optimization", body: "We review the ad accounts we manage, find what's working and what isn't, and recommend or apply improvements with our team's approval." },
  { title: "Onboarding", body: "New clients share access to their ad accounts, brand assets and goals in one guided place." },
];

export default function About() {
  return (
    <article className="grid gap-10 pt-6">
      <section className="grid gap-4">
        <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-faint">Kaizen Marketing</p>
        <h1 className="font-heading text-[34px] leading-[1.08] tracking-tight md:text-[44px]">Kaizen Ads</h1>
        <p className="max-w-2xl text-[16px] leading-relaxed text-muted">
          Kaizen Ads is the platform Kaizen Marketing, a performance marketing agency, uses to run its clients&rsquo; paid advertising on Meta (Facebook and Instagram) and Google Ads. It&rsquo;s used by the Kaizen team and by the clients we invite to review and approve their ads and follow their results.
        </p>
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        {FEATURES.map((f) => (
          <div key={f.title} className="grid gap-1.5 rounded-[18px] border border-line bg-surface p-5">
            <h2 className="font-heading text-[17px]">{f.title}</h2>
            <p className="text-[14px] leading-relaxed text-muted">{f.body}</p>
          </div>
        ))}
      </section>

      <section className="grid gap-3">
        <h2 className="font-heading text-[22px]">How Kaizen Ads uses Google data</h2>
        <p className="text-[15px] leading-relaxed text-muted">
          Kaizen Ads connects to the Google Ads API to read the performance of the Google Ads accounts our clients have given Kaizen Marketing access to, through our manager (MCC) account. We use that data to report results to each client, audit their campaigns and recommend improvements. With our team&rsquo;s approval, Kaizen Ads can make changes in those accounts, such as adding keywords or ads (created paused) or adjusting campaigns. We only access accounts that clients have linked to Kaizen Marketing, and only to manage their advertising.
        </p>
        <p className="text-[15px] leading-relaxed text-muted">
          Members of the Kaizen team can sign in with their Google Workspace account. Kaizen Ads&rsquo; use and transfer of information received from Google APIs adheres to the{" "}
          <a className="text-brand-text underline" href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. Read our <Link href="/privacy" className="text-brand-text underline">privacy policy</Link> and <Link href="/terms" className="text-brand-text underline">terms of service</Link>.
        </p>
      </section>

      <section className="grid gap-2 rounded-[18px] border border-line bg-surface p-5">
        <h2 className="font-heading text-[17px]">Contact</h2>
        <p className="text-[14px] text-muted">
          Questions about Kaizen Ads or your data: <a className="text-brand-text underline" href="mailto:santi@kaizenmarketing.agency">santi@kaizenmarketing.agency</a>. Kaizen Marketing:{" "}
          <a className="text-brand-text underline" href="https://kaizenmarketing.agency" target="_blank" rel="noreferrer">kaizenmarketing.agency</a>
        </p>
      </section>
    </article>
  );
}
