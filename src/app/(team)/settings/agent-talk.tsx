"use client";

import Link from "next/link";
import { AgentIcon, ChatPanel } from "./agents";
import { AgentCall } from "./agent-call";
import { chatWithAgent, clearRoleChat, type RoleChatMessage } from "./actions";
import { AGENT_TINT } from "@/lib/agent-look";

// Talking to an agent you don't train: every agent, for everyone on the team. Ask it about your clients and their
// numbers (it reads only what you may see), or ask it to remind you or pass something on to a teammate. No teaching
// and no voice settings here: only an executive or the head of the agent's line changes what it knows.

export type TalkRole = { key: string; label: string; description: string; icon: string; line: string };

const tint = (icon: string) => AGENT_TINT[icon] ?? AGENT_TINT.spark;

const STARTERS = ["Who are my top three clients this month?", "Which clients are furthest off target?", "What's the best performing one this month, and why did it work?", "Remind me to follow up on this tomorrow"];

/** Every agent to talk to, by line: a card each that opens its page */
export function AgentsToTalk({ roles, title = "Talk to the agents", sub }: { roles: TalkRole[]; title?: string; sub?: string }) {
  if (!roles.length) return null;
  return (
    <section className="grid gap-4">
      <div>
        <h2 className="font-heading text-[22px] leading-tight">{title}</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">{sub ?? "Call or chat with any of them. Ask about your clients and their numbers, or ask them to remind you or pass something on. They only see what you can see."}</p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {roles.map((r) => (
          <li key={r.key}>
            <Link href={`/settings?tab=agents&role=${r.key}`} className="group flex h-full min-h-24 items-start gap-3.5 rounded-[18px] border border-line bg-surface p-4 transition-colors hover:border-faint active:bg-surface-2">
              <AgentIcon icon={r.icon} size={44} />
              <span className="grid min-w-0 flex-1 gap-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-heading text-[16px] leading-tight">{r.label}</span>
                  <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] text-muted">{r.line}</span>
                </span>
                <span className="line-clamp-2 text-[13px] leading-relaxed text-muted">{r.description}</span>
              </span>
              <span aria-hidden className="pt-1 text-faint transition-transform group-hover:translate-x-0.5">
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One agent, to talk to: call or huddle with it, and its chat (your own conversation with it) */
export function AgentTalk({ role, chat }: { role: TalkRole; chat: RoleChatMessage[] }) {
  const icon = (size: number) => <AgentIcon icon={role.icon} size={size} />;
  return (
    <div className="grid gap-6 pb-24">
      <Link href="/settings?tab=agents" className="inline-flex min-h-11 items-center text-xs text-muted hover:text-fg md:min-h-0">
        ← All agents
      </Link>
      <header className="relative overflow-hidden rounded-[20px] border border-line bg-surface p-5 sm:p-8">
        <span aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full opacity-20 blur-3xl" style={{ background: tint(role.icon) }} />
        <div className="relative flex flex-wrap items-start gap-5">
          {icon(64)}
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-[0.16em] text-faint">Agent · {role.line}</p>
            <h2 className="font-heading text-[26px] leading-tight [overflow-wrap:anywhere] md:text-[30px]">{role.label}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{role.description}</p>
            <div className="mt-4">
              <AgentCall roleKey={role.key} label={role.label} icon={icon} tint={tint(role.icon)} />
            </div>
            <p className="mt-3 max-w-2xl text-[12.5px] leading-relaxed text-faint">Ask it about your clients and their numbers, or to remind you of something or pass it on to a teammate. It only reads what you can see. The head of its line and the executives shape what it knows.</p>
          </div>
        </div>
      </header>
      <section id="talk" className="grid scroll-mt-6 gap-4 rounded-[20px] border border-line bg-surface p-4 sm:p-6">
        <div>
          <h3 className="font-heading text-[20px] leading-tight">Talk to the {role.label}</h3>
          <p className="mt-1 max-w-2xl text-sm text-muted">Your own conversation with it: your calls show up here too.</p>
        </div>
        <ChatPanel
          tall
          icon={role.icon}
          heading={`Hi, I'm the ${role.label}`}
          intro="Ask me about your clients, rankings and what's working, or ask me to remind you of something or get a teammate on it."
          starters={STARTERS}
          placeholder={`Ask the ${role.label}…`}
          footnote="Reads only what you can see. Nothing goes to a client from here."
          thinkingLabel="Looking into it…"
          initial={chat}
          items={[]}
          folder={role.key}
          threadId={`role:${role.key}`}
          onSend={(msg, files) => chatWithAgent(role.key, msg, files)}
          onApply={async () => ({ ok: false as const, error: "Only the head of this agent's line or an executive applies changes." })}
          onClear={() => clearRoleChat(role.key)}
        />
      </section>
    </div>
  );
}
