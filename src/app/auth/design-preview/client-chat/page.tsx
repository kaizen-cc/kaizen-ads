import { notFound } from "next/navigation";
import { ClientChat } from "@/app/(team)/clients/[slug]/client-chat";

// The client page's AI chat with sample data, for designing it without signing in. Development only.

export default function ClientChatPreview() {
  if (process.env.NODE_ENV !== "development") notFound();
  return (
    <main className="min-h-screen bg-bg p-10 text-fg">
      <h1 className="font-heading text-3xl">Machinery Auctioneers</h1>
      <ClientChat
        clientId="demo"
        client="Machinery Auctioneers"
        live
        targets={[
          { id: "a", label: "Meta", status: "ready", auditId: "x" },
          { id: "b", label: "Google · Search", status: "none", auditId: null },
        ]}
        initial={[
          { role: "user", text: "Summarize where this account stands", at: "" },
          { role: "assistant", text: "Meta is 18% over the cost-per-lead target over the last 14 days, mostly from the truck catalog ad set after the Oct 2 creative refresh.\n- The client asked on the Oct 9 call to lead with trucks over equipment.\n- One promise from that call (buyer and seller copy) hasn't started.\n- The last audit says to consolidate the two lead ad sets and test a seller-side angle.", at: "" },
        ]}
      />
    </main>
  );
}
