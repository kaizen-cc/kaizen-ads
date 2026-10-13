const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The sign-in email a client receives. One button, no password. */
export function magicLinkEmail(params: { link: string; brandName?: string | null; firstName?: string | null }) {
  const hello = params.firstName ? `Hi ${params.firstName},` : "Hi there,";
  const where = params.brandName ? `${params.brandName} on Kaizen Ads` : "Kaizen Ads";
  const subject = `Your sign-in link for ${where}`;
  const text = [
    hello,
    "",
    `Use this link to sign in to ${where}. It works once and expires in 1 hour.`,
    "",
    params.link,
    "",
    "If you didn't ask for this, you can ignore this email.",
    "",
    "— Kaizen Marketing",
  ].join("\n");
  const html = `<div style="background:#060606;padding:32px 16px;font-family:Poppins,system-ui,-apple-system,Segoe UI,sans-serif">
  <div style="max-width:440px;margin:0 auto;background:#101011;border:1px solid #26262a;border-radius:8px;padding:28px;color:#f2f2f2">
    <p style="margin:0 0 20px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#9a9aa2">Kaizen Ads</p>
    <p style="margin:0 0 8px;font-size:15px">${esc(hello)}</p>
    <p style="margin:0 0 24px;font-size:15px;line-height:1.5;color:#d8d8dc">Use the button below to sign in to ${esc(where)}. It works once and expires in 1 hour.</p>
    <a href="${esc(params.link)}" style="display:inline-block;background:#b21e2c;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:5px">Sign in to Kaizen Ads</a>
    <p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#6a6a72">If the button doesn't work, copy this link into your browser:<br><span style="word-break:break-all;color:#9a9aa2">${esc(params.link)}</span></p>
    <p style="margin:16px 0 0;font-size:12px;color:#6a6a72">Didn't ask for this? You can ignore this email.</p>
  </div>
</div>`;
  return { subject, text, html };
}
