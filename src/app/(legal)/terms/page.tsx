import type { Metadata } from "next";

export const metadata: Metadata = { title: "Terms of service · Kaizen Ads", description: "The terms for using Kaizen Ads, by Kaizen Marketing." };

const UPDATED = "November 4, 2026";

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-4 font-heading text-[20px]">{children}</h2>;
}

export default function Terms() {
  return (
    <article className="grid gap-4 pt-6 text-[15px] leading-relaxed text-muted [&_li]:ml-5 [&_li]:list-disc">
      <h1 className="font-heading text-[32px] leading-tight tracking-tight text-fg md:text-[40px]">Terms of service</h1>
      <p className="text-[13px] text-faint">Last updated {UPDATED}</p>
      <p>
        Kaizen Ads (ads.kaizenmarketing.agency) is provided by Kaizen Marketing (&ldquo;Kaizen&rdquo;, &ldquo;we&rdquo;) to its team and to the clients it works with. By using Kaizen Ads you agree to these terms. Your agreement with Kaizen Marketing for our services also applies, and wins where the two differ.
      </p>

      <H>Who can use it</H>
      <p>Kaizen Ads is for Kaizen Marketing&rsquo;s team and for client contacts we invite. Keep your sign-in links and account to yourself, and tell us if you think someone else has used them.</p>

      <H>What it&rsquo;s for</H>
      <ul className="grid gap-1.5">
        <li>Reviewing and approving the ads we make for you, and asking for changes.</li>
        <li>Sharing access, brand assets and information about your business with our team.</li>
        <li>Following your advertising results and talking with our team.</li>
      </ul>
      <p>Don&rsquo;t misuse it: no attempts to access other clients&rsquo; information, break its security, or upload anything unlawful or that you don&rsquo;t have the right to share.</p>

      <H>Your content and accounts</H>
      <p>
        You keep ownership of the content and data you share with us. You give Kaizen Marketing permission to use it to provide our services to you, including to make, launch and report on your advertising. You confirm you&rsquo;re allowed to give us access to the ad accounts, stores and other services you connect, and you can remove that access at any time.
      </p>

      <H>Advertising platforms</H>
      <p>
        Your campaigns run on platforms such as Meta and Google Ads, under their own terms and policies. Ad spend is billed to you by those platforms. Approvals you give in Kaizen Ads authorize us to publish the approved ads.
      </p>

      <H>Results</H>
      <p>
        We work hard to grow your results, but advertising results depend on many factors outside our control, and figures shown in Kaizen Ads come from the platforms and services you connect. Kaizen Ads is provided as is, without warranties beyond those in your agreement with us.
      </p>

      <H>Limits</H>
      <p>To the extent the law allows, Kaizen Marketing isn&rsquo;t liable for indirect or consequential losses arising from use of Kaizen Ads; our responsibilities to you are set by your agreement with us.</p>

      <H>Changes and ending</H>
      <p>We may update Kaizen Ads and these terms, and will tell clients about significant changes. Access ends when our work together ends; you can ask us for your information or its deletion at any time.</p>

      <H>Contact</H>
      <p>
        Kaizen Marketing · <a className="text-brand-text underline" href="mailto:santi@kaizenmarketing.agency">santi@kaizenmarketing.agency</a> ·{" "}
        <a className="text-brand-text underline" href="https://kaizenmarketing.agency" target="_blank" rel="noreferrer">kaizenmarketing.agency</a>
      </p>
    </article>
  );
}
