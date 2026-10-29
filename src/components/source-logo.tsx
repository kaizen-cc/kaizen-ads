// Where a message came from, at a glance: the Slack or Gmail mark in a small chip, so Slack and email items read
// differently on a busy board. The marks keep their own colours in light and dark.

function SlackMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 122.8 122.8" aria-hidden>
      <path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#e01e5a" />
      <path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36c5f0" />
      <path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2eb67d" />
      <path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ecb22e" />
    </svg>
  );
}

function GmailMark({ size }: { size: number }) {
  return (
    <svg width={size} height={(size * 18) / 24} viewBox="0 0 24 18" aria-hidden>
      <path d="M1.6 18h3.8V8.7L0 4.6v11.8C0 17.3.7 18 1.6 18z" fill="#4285f4" />
      <path d="M18.6 18h3.8c.9 0 1.6-.7 1.6-1.6V4.6l-5.4 4.1V18z" fill="#34a853" />
      <path d="M18.6 1.6v7.1L24 4.6V2.5C24 .4 21.7-.7 20.1.5l-1.5 1.1z" fill="#fbbc04" />
      <path d="M5.4 8.7V1.6L12 6.5l6.6-4.9v7.1L12 13.6 5.4 8.7z" fill="#ea4335" />
      <path d="M0 2.5v2.1l5.4 4.1V1.6L3.9.5C2.3-.7 0 .4 0 2.5z" fill="#c5221f" />
    </svg>
  );
}

export function SourceChip({ source }: { source: "slack" | "gmail" }) {
  const slack = source === "slack";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${slack ? "border-[#4a154b]/30 bg-[#4a154b]/10 text-fg" : "border-[#ea4335]/25 bg-[#ea4335]/[0.07] text-fg"}`}>
      {slack ? <SlackMark size={12} /> : <GmailMark size={13} />}
      {slack ? "Slack" : "Email"}
    </span>
  );
}
