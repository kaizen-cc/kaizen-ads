import { TeamShell } from "@/components/team-shell";
import { requireStaff } from "@/lib/auth";
import { roleLabel } from "@/lib/roles";

export default async function TeamLayout({ children }: LayoutProps<"/">) {
  const me = await requireStaff();
  return (
    <TeamShell name={me.fullName} roles={roleLabel(me.role)}>
      {children}
    </TeamShell>
  );
}
