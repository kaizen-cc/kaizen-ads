"use client";

import { useAgentCall } from "@/components/agent-call-provider";
import { HeadsetIcon, PhoneIcon } from "@/components/agent-call-views";
import { AgentGlyph } from "@/components/assistant-call-parts";
import { CALL_ROLES, type CallContext } from "@/lib/agent-call/call-context";
import { tintOf } from "@/lib/agent-look";

// The Call button beside a chat in the app (Kaizen AI, the client desk, the KPI board's Ask about, a report's AI): a
// voice call with the agent that fits what's on screen, carrying where it was pressed (the client, the report, the
// thread). Phones say Call and open the full screen call; computers say Huddle and open the huddle.

type Props = {
  /** The agent it reaches (an ai_roles key, or "assistant") */
  roleKey: string;
  context: CallContext;
  /** "pill": an outlined button with words; "icon": a round button for a tight composer row */
  variant?: "pill" | "icon";
  className?: string;
};

export function CallButton({ roleKey, context, variant = "pill", className = "" }: Props) {
  const { start, activeRole, live, assistantTint } = useAgentCall();
  const look = CALL_ROLES[roleKey] ?? CALL_ROLES.assistant;
  const key = CALL_ROLES[roleKey] ? roleKey : "assistant";
  const tint = key === "assistant" ? assistantTint : tintOf(look.icon);
  const who = key === "assistant" ? "your assistant" : `the ${look.label}`;
  const here = live && activeRole === key;
  const about = context.client ? ` about ${context.client}` : "";
  const dial = () => start({ roleKey: key, label: look.label, tint, icon: (size) => <AgentGlyph icon={look.icon} tint={tint} size={size} />, context });

  if (variant === "icon")
    return (
      <button
        type="button"
        onClick={dial}
        aria-label={here ? `Back to the call with ${who}` : `Call ${who}${about}`}
        title={here ? `Back to the call with ${who}` : `Call ${who}${about}`}
        className={`relative grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-ink/[0.05] hover:text-fg active:scale-95 ${className}`}
      >
        {here && <span aria-hidden className="absolute right-2 top-2 h-2 w-2 rounded-full bg-ok" />}
        <span className="md:hidden">
          <PhoneIcon size={17} />
        </span>
        <span className="hidden md:inline">
          <HeadsetIcon size={17} />
        </span>
      </button>
    );

  return (
    <button
      type="button"
      onClick={dial}
      title={here ? `Back to the call with ${who}` : `Talk it through with ${who}${about}`}
      className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-full border border-line px-4 text-sm text-muted transition-colors hover:border-brand/50 hover:text-fg active:scale-[0.98] md:h-9 ${className}`}
    >
      <span className="md:hidden">
        <PhoneIcon size={15} />
      </span>
      <span className="hidden md:inline">
        <HeadsetIcon size={15} />
      </span>
      <span className="md:hidden">{here ? "On the call" : "Call"}</span>
      <span className="hidden md:inline">{here ? "In the huddle" : "Huddle"}</span>
    </button>
  );
}
