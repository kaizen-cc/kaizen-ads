import type { Metadata } from "next";
import { Suspense } from "react";
import { aiEnabled } from "@/lib/ai";
import { requireStaff } from "@/lib/auth";
import { agentForRole, groupsFor } from "@/lib/kaizen-ai/agents";
import { AGENT_LABEL } from "@/lib/kaizen-ai/types";
import { listTemplates, listThreads, needsClaudeImport, pickableClients } from "./actions";
import { KaizenAi } from "./kaizen-ai";

export const metadata: Metadata = { title: "Kaizen AI" };

export default async function KaizenAiPage() {
  const me = await requireStaff();
  const [threads, templates, clients, mustImport] = await Promise.all([listThreads(), listTemplates(), pickableClients(), needsClaudeImport().catch(() => false)]);
  const home = agentForRole(me.role);
  return (
    <Suspense>
      <KaizenAi
        me={{ id: me.id, first: me.fullName.split(" ")[0] ?? "", role: me.role }}
        on={aiEnabled()}
        initialThreads={threads}
        initialTemplates={templates}
        clients={clients}
        groups={groupsFor(me.role)}
        homeAgent={{ key: home, label: AGENT_LABEL[home] }}
        mustImport={mustImport}
      />
    </Suspense>
  );
}
