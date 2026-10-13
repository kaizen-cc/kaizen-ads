import { TeamShell } from "@/components/team-shell";
import { requireStaff } from "@/lib/auth";
import { roleLabels } from "@/lib/roles";

export default async function TeamLayout({ children }: LayoutProps<"/">) {
  const me = await requireStaff();
  return (
    <TeamShell name={me.fullName} roles={roleLabels(me).join(" · ") || "Team"}>
      {children}
    </TeamShell>
  );
}
