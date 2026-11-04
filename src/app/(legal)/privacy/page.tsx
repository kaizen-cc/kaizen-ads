import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy policy · Kaizen Ads", description: "How Kaizen Ads, by Kaizen Marketing, collects, uses and protects information." };

const UPDATED = "November 4, 2026";

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-4 font-heading text-[20px]">{children}</h2>;
}

export default function Privacy() {
  return (
    <article className="grid gap-4 pt-6 text-[15px] leading-relaxed text-muted [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-fg">
      <h1 className="font-heading text-[32px] leading-tight tracking-tight text-fg md:text-[40px]">Privacy policy</h1>
      <p className="text-[13px] text-faint">Last updated {UPDATED}</p>
      <p>
        This policy explains how Kaizen Marketing (&ldquo;Kaizen&rdquo;, &ldquo;we&rdquo;) collects, uses and protects information in Kaizen Ads (ads.kaizenmarketing.agency), the platform we use to run our clients&rsquo; advertising. Kaizen Ads is used by the Kaizen team and by the clients we invite.
      </p>

      <H>Information we collect</H>
      <ul className="grid gap-1.5">
        <li><strong>Account information:</strong> the name and email address of Kaizen team members and of client contacts we invite, used to sign in and to send them their ads, reports and notices.</li>
        <li><strong>Advertising data:</strong> campaign, ad set, ad, keyword and performance data from the Meta and Google Ads accounts our clients have given Kaizen Marketing access to.</li>
        <li><strong>Content our clients share with us:</strong> brand assets, creative, answers to our intake form, comments and approvals in the client portal, and messages in their team channel.</li>
        <li><strong>Business results our clients connect:</strong> where a client connects a store or CRM, the order, lead and customer counts we use to measure their advertising (without customers&rsquo; names or emails).</li>
        <li><strong>Usage information:</strong> basic logs of activity in Kaizen Ads, used to keep it secure and working.</li>
      </ul>

      <H>Information from Google</H>
      <p>Kaizen Ads uses Google services in two ways:</p>
      <ul className="grid gap-1.5">
        <li><strong>Google Ads API:</strong> we read the performance and settings of the Google Ads accounts our clients have linked to Kaizen Marketing&rsquo;s manager account, to report their results, audit their campaigns and recommend improvements. With our team&rsquo;s approval, Kaizen Ads can make changes in those accounts (for example adding keywords or paused ads). We only access accounts clients have linked to us, and only to manage their advertising.</li>
        <li><strong>Google sign-in:</strong> Kaizen team members can sign in with their Google Workspace account. We receive their name, email address and profile picture, and use them only to sign them in.</li>
      </ul>
      <p>
        Kaizen Ads&rsquo; use and transfer to any other app of information received from Google APIs will adhere to the{" "}
        <a className="text-brand-text underline" href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements. In particular, we:
      </p>
      <ul className="grid gap-1.5">
        <li>use Google user data only to provide and improve the features of Kaizen Ads described here;</li>
        <li>do not sell Google user data, or use or transfer it for advertising, credit-worthiness or lending purposes;</li>
        <li>do not use Google user data to develop, improve or train generalized artificial intelligence or machine learning models;</li>
        <li>do not allow humans to read Google user data except with the client&rsquo;s permission, to provide the service, for security, or to comply with the law.</li>
      </ul>

      <H>How we use information</H>
      <ul className="grid gap-1.5">
        <li>To run our clients&rsquo; advertising: briefing and making creative, getting approvals, launching and optimizing campaigns.</li>
        <li>To report results and answer clients&rsquo; questions about their accounts.</li>
        <li>To communicate with clients and our team about their work.</li>
        <li>To keep Kaizen Ads secure and fix problems.</li>
      </ul>
      <p>
        Kaizen Ads uses AI models (through Anthropic&rsquo;s API) to help our team analyze accounts and draft work. Data sent to these models is used only to produce that work for the client it belongs to; under our provider&rsquo;s commercial terms it is not used to train their models.
      </p>

      <H>Sharing</H>
      <p>We don&rsquo;t sell personal information. We share information only with:</p>
      <ul className="grid gap-1.5">
        <li>service providers that host and run Kaizen Ads for us (Supabase for the database and storage, Vercel for hosting, Anthropic for AI processing, Resend for email, Slack for team and client messaging), under agreements that protect it;</li>
        <li>the advertising platforms themselves (Meta and Google), when we manage a client&rsquo;s campaigns;</li>
        <li>authorities, when the law requires it.</li>
      </ul>

      <H>Security and retention</H>
      <p>
        Information is encrypted in transit and at rest, access is limited to the people who need it, and keys for connected services are stored encrypted. We keep a client&rsquo;s information while we work with them and as needed afterwards to meet legal obligations, then delete it, or earlier on request.
      </p>

      <H>Your choices</H>
      <p>
        Clients can ask us to access, correct or delete their information, or to disconnect an ad account, store or CRM, at any time by writing to{" "}
        <a className="text-brand-text underline" href="mailto:santi@kaizenmarketing.agency">santi@kaizenmarketing.agency</a>. You can also remove Kaizen Marketing&rsquo;s access to a Google Ads account from the account&rsquo;s access settings, and revoke Google sign-in at{" "}
        <a className="text-brand-text underline" href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">myaccount.google.com/permissions</a>.
      </p>

      <H>Changes</H>
      <p>We&rsquo;ll update this page when this policy changes, and tell clients about significant changes.</p>

      <H>Contact</H>
      <p>
        Kaizen Marketing · <a className="text-brand-text underline" href="mailto:santi@kaizenmarketing.agency">santi@kaizenmarketing.agency</a> ·{" "}
        <a className="text-brand-text underline" href="https://kaizenmarketing.agency" target="_blank" rel="noreferrer">kaizenmarketing.agency</a>
      </p>
    </article>
  );
}
