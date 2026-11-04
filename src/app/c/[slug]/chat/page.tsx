import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { chatAccess } from "@/app/api/portal-chat/access";
import { ChatView } from "./chat-view";

export const metadata: Metadata = { title: "Chat · Kaizen", robots: { index: false, follow: false } };

// The client's team chat: their Slack channel with Kaizen, right in the portal. Everything loads from the browser
// (it keeps itself up to date while open), so the page itself is only the frame.
export default async function ChatPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const a = await chatAccess(slug);
  if (!a) notFound();
  const channel = (a.client.slack_channel_id as string | null) ?? null;
  return <ChatView slug={a.client.slug as string} brand={a.client.name as string} me={a.name} team={a.team} hasChannel={Boolean(channel && process.env.SLACK_BOT_TOKEN)} slackLink={channel ? `https://slack.com/app_redirect?channel=${channel}` : null} />;
}
