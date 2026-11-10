// The AI media panels for a client who said no to AI content (src/lib/ai-content.ts): why nothing is offered here,
// with what they told us.

export function NoAiNote({ text }: { text: string }) {
  return (
    <p role="note" className="flex items-start gap-2.5 rounded-[12px] border border-line bg-surface px-4 py-3 text-xs leading-relaxed text-muted">
      <span aria-hidden className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border border-faint text-[10px] leading-none text-faint">
        !
      </span>
      <span>{text}</span>
    </p>
  );
}
