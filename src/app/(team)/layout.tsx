import { TeamShell } from "@/components/team-shell";
import { UploadProvider } from "@/components/upload-provider";
import { requireStaff } from "@/lib/auth";
import { roleLabel } from "@/lib/roles";

export default async function TeamLayout({ children }: LayoutProps<"/">) {
  const me = await requireStaff();
  return (
    <UploadProvider>
      <TeamShell name={me.fullName} roles={roleLabel(me.role)} tier={me.isExec ? "exec" : me.isLead ? "lead" : "member"}>
        {children}
      </TeamShell>
    </UploadProvider>
  );
}
