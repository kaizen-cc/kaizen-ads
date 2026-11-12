import { SocialTab, type SocialTabInput } from "./social-panel";

// The Social service's tabs for the client page's tab bar (Overview and Posts; without numbers yet, one Overview tab
// that says why and offers the link). Kept out of the client component file: the server can render its components but
// can't call a function exported from it.
export function socialTabs(input: SocialTabInput) {
  if (!input.data) return [{ id: "overview", label: "Overview", hint: "Followers, reach and engagement from Facebook and Instagram (read only)", content: <SocialTab {...input} tab="empty" /> }];
  return [
    { id: "overview", label: "Overview", hint: "Followers, reach, engagement and posting rhythm over time, and the account's health", content: <SocialTab {...input} tab="overview" /> },
    { id: "posts", label: "Posts", hint: "Every recent post: sortable, with reach, interactions, rate, saves and shares; the best and the weakest", content: <SocialTab {...input} tab="posts" /> },
  ];
}
