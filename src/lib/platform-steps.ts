// The click-by-click for every platform a client gives us access to beyond Meta and Google Ads: Google Analytics, Tag
// Manager, Business Profile and Merchant Center, their website (Shopify, WordPress, Wix, Squarespace, Webflow) and their
// email platform (Klaviyo, Mailchimp, Attentive, Postscript, Omnisend). Plain data: the guide draws each step as a
// picture of the screen, and the setup help reads the same steps, so both always say the same thing.
// In body text, **bold** marks what they click; {tech} and {klaviyo} are the addresses they add (from the setting).

export type PlatformStep = {
  title: string;
  body: string;
  /** The address shown in the drawing */
  url: string;
  /** A side menu, with the item to pick */
  menu?: string[];
  active?: string;
  /** A dialog to draw: its title, the fields (as filled in) and the button */
  panel?: { title: string; rows: string[]; hit: string };
  /** Or one button in the middle of the screen */
  hit?: string;
  /** An address to copy under the text */
  copy?: "tech" | "klaviyo";
  /** A link to open */
  link?: string;
};

const ADMIN = "Administrator";

export const PLATFORM_STEPS: Record<string, PlatformStep[]> = {
  ga4: [
    { title: "Open Google Analytics", body: "On a computer, open **analytics.google.com**, signed in with the Google account that owns your Analytics. Click **Admin** (the gear, bottom left).", url: "analytics.google.com", hit: "⚙ Admin", link: "https://analytics.google.com/analytics/web/" },
    { title: "Account access management", body: "Under **Account**, click **Account access management**.", url: "analytics.google.com/analytics/web/#/admin", menu: ["Account", "  Account details", "  Account access management", "Property", "  Property details", "  Property access management", "  Data streams"], active: "  Account access management" },
    { title: "Add Kaizen as an Administrator", body: "Click **+** (top right) › **Add users**. Paste our address, pick **Administrator**, and click **Add**.", url: "analytics.google.com/analytics/web/#/admin", panel: { title: "Add roles and data restrictions", rows: ["{tech}", `Role: ${ADMIN}`], hit: "Add" }, copy: "tech" },
  ],
  gtm: [
    { title: "Open Tag Manager", body: "Open **tagmanager.google.com**, signed in with the Google account that owns it, and click **Admin** (top).", url: "tagmanager.google.com", hit: "Admin", link: "https://tagmanager.google.com/" },
    { title: "User management", body: "Under **Account**, click **User Management**.", url: "tagmanager.google.com/#/admin", menu: ["Account", "  Account settings", "  User management", "Container", "  Container settings", "  User management"], active: "  User management" },
    { title: "Add Kaizen", body: "Click **+** › **Add users**. Paste our address, set the account to **Administrator** and the container to **Publish**, then **Invite**.", url: "tagmanager.google.com/#/admin", panel: { title: "Add users", rows: ["{tech}", "Account: Administrator", "Container: Publish"], hit: "Invite" }, copy: "tech" },
  ],
  gbp: [
    { title: "Open your Business Profile", body: "Open **business.google.com**, signed in with the Google account that manages your listing, and pick your business. (Or search your business name on Google while signed in.)", url: "business.google.com", hit: "Your business", link: "https://business.google.com/" },
    { title: "People and access", body: "Click **⋮** (more) › **Business Profile settings** › **People and access**.", url: "business.google.com/settings", menu: ["Business Profile settings", "  People and access", "  Advanced settings", "  Linked accounts"], active: "  People and access" },
    { title: "Add Kaizen as a Manager", body: "Click **Add**, paste our address, pick **Manager**, then **Invite**.", url: "business.google.com/settings/people", panel: { title: "Add new users", rows: ["{tech}", "Access: Manager"], hit: "Invite" }, copy: "tech" },
  ],
  merchant: [
    { title: "Open Merchant Center", body: "Open **merchants.google.com**, signed in with the Google account that owns your store's Merchant Center.", url: "merchants.google.com", hit: "Merchant Center", link: "https://merchants.google.com/" },
    { title: "People and access", body: "Click **Settings** (the gear) › **People and access**.", url: "merchants.google.com/settings/people", menu: ["Settings", "  Business info", "  People and access", "  Linked accounts"], active: "  People and access" },
    { title: "Add Kaizen as an Admin", body: "Click **Add person**, paste our address, give **Admin** access, then **Add**.", url: "merchants.google.com/settings/people", panel: { title: "Add person", rows: ["{tech}", "Access: Admin"], hit: "Add" }, copy: "tech" },
  ],
  shopify: [
    { title: "Open your Shopify admin", body: "Open **admin.shopify.com** and click **Settings** (bottom left).", url: "admin.shopify.com", hit: "⚙ Settings", link: "https://admin.shopify.com/" },
    { title: "Copy your collaborator request code", body: "Click **Users and permissions** (or **Users**), scroll down to **Collaborators**. Leave **Only people with a collaborator request code** on, and copy the 4-digit **collaborator request code**.", url: "admin.shopify.com/settings/account", menu: ["Settings", "  General", "  Plan", "  Billing", "  Users and permissions", "  Domains"], active: "  Users and permissions", panel: { title: "Collaborators", rows: ["Only people with a collaborator request code", "Collaborator request code: 1234"], hit: "Copy" } },
    { title: "Find your store address", body: "Click **Domains**: your store's address ends in **.myshopify.com** (like yourstore.myshopify.com). Copy it.", url: "admin.shopify.com/settings/domains", menu: ["Settings", "  General", "  Plan", "  Billing", "  Users and permissions", "  Domains"], active: "  Domains", panel: { title: "Domains", rows: ["yourstore.myshopify.com", "www.yourstore.com"], hit: "Copy" } },
  ],
  wordpress: [
    { title: "Open your WordPress admin", body: "Go to your site's admin (**yoursite.com/wp-admin**) and sign in. Click **Users** › **Add New User**.", url: "yoursite.com/wp-admin/user-new.php", menu: ["Dashboard", "Posts", "Pages", "Users", "  All Users", "  Add New User", "Settings"], active: "  Add New User" },
    { title: "Add Kaizen as an Administrator", body: "Username **kaizen**, paste our address as the email, set the role to **Administrator**, and click **Add New User**.", url: "yoursite.com/wp-admin/user-new.php", panel: { title: "Add New User", rows: ["Username: kaizen", "{tech}", `Role: ${ADMIN}`], hit: "Add New User" }, copy: "tech" },
  ],
  wix: [
    { title: "Open Roles & Permissions", body: "In your **Wix dashboard**, click **Settings** › **Roles & Permissions**.", url: "manage.wix.com/dashboard/settings", menu: ["Settings", "  Business info", "  Roles & Permissions", "  Domains"], active: "  Roles & Permissions", link: "https://manage.wix.com/" },
    { title: "Invite Kaizen as an Admin", body: "Click **Invite People**, paste our address, pick **Admin (Co-owner)**, and **Send Invite**.", url: "manage.wix.com/dashboard/settings/roles", panel: { title: "Invite people", rows: ["{tech}", "Role: Admin (Co-owner)"], hit: "Send Invite" }, copy: "tech" },
  ],
  squarespace: [
    { title: "Open Permissions", body: "In your Squarespace site, click **Settings** › **Permissions & Ownership**.", url: "yoursite.squarespace.com/config/settings", menu: ["Settings", "  Website", "  Domains", "  Permissions & Ownership", "  Billing"], active: "  Permissions & Ownership" },
    { title: "Invite Kaizen as an Administrator", body: "Click **Invite contributor**, paste our address, tick **Administrator**, and **Invite**.", url: "yoursite.squarespace.com/config/settings/permissions", panel: { title: "Invite contributor", rows: ["{tech}", `Permissions: ${ADMIN}`], hit: "Invite" }, copy: "tech" },
  ],
  webflow: [
    { title: "Open your Workspace members", body: "In **Webflow**, open your **Workspace settings** › **Members**.", url: "webflow.com/dashboard/workspace/settings", menu: ["Workspace settings", "  General", "  Members", "  Billing"], active: "  Members", link: "https://webflow.com/dashboard" },
    { title: "Invite Kaizen as an Admin", body: "Click **Invite members**, paste our address, pick **Admin**, and **Send invite**.", url: "webflow.com/dashboard/workspace/settings/members", panel: { title: "Invite members", rows: ["{tech}", "Role: Admin"], hit: "Send invite" }, copy: "tech" },
  ],
  "website-other": [{ title: "Add Kaizen as an admin", body: "In your website's settings, find **Users**, **Team** or **Permissions**, and invite our address with **admin** (full) access. Tell us the platform below.", url: "your website's admin", hit: "Invite user", copy: "tech" }],
  klaviyo: [
    { title: "Open your Klaviyo settings", body: "In **Klaviyo**, click your account name (bottom left) › **Settings**.", url: "www.klaviyo.com/settings/account", hit: "Settings", link: "https://www.klaviyo.com/settings/account" },
    { title: "Users", body: "Open the **Users** tab and click **Add new user**.", url: "www.klaviyo.com/settings/account/users", menu: ["Account", "  Contact information", "  Users", "  Security"], active: "  Users" },
    { title: "Add Kaizen as an Admin", body: "Paste our address, pick **Admin**, and click **Add user**.", url: "www.klaviyo.com/settings/account/users", panel: { title: "Add new user", rows: ["{klaviyo}", "Role: Admin"], hit: "Add user" }, copy: "klaviyo" },
  ],
  mailchimp: [
    { title: "Open Users", body: "In **Mailchimp**, click your profile picture › **Account & billing** › **Settings** › **Users**.", url: "us1.admin.mailchimp.com/account/users", menu: ["Account & billing", "  Overview", "  Settings", "  Users", "  Billing"], active: "  Users", link: "https://login.mailchimp.com/" },
    { title: "Invite Kaizen as an Admin", body: "Click **Invite a user**, paste our address, pick **Admin**, and **Send invite**.", url: "us1.admin.mailchimp.com/account/users/invite", panel: { title: "Invite a user", rows: ["{tech}", "Role: Admin"], hit: "Send invite" }, copy: "tech" },
  ],
  attentive: [
    { title: "Open Users", body: "In **Attentive**, click **Settings** (the gear) › **Users**.", url: "ui.attentivemobile.com/settings/users", menu: ["Settings", "  Company", "  Users", "  Integrations"], active: "  Users", link: "https://ui.attentivemobile.com/" },
    { title: "Invite Kaizen as an Admin", body: "Click **Invite user**, paste our address, pick **Admin**, and **Invite**.", url: "ui.attentivemobile.com/settings/users", panel: { title: "Invite user", rows: ["{tech}", "Role: Admin"], hit: "Invite" }, copy: "tech" },
  ],
  postscript: [
    { title: "Open your team", body: "In **Postscript**, click **Settings** › **Team**.", url: "app.postscript.io/settings/team", menu: ["Settings", "  Shop", "  Team", "  Billing"], active: "  Team", link: "https://app.postscript.io/" },
    { title: "Invite Kaizen as an Admin", body: "Click **Invite**, paste our address, pick **Admin**, and **Send invite**.", url: "app.postscript.io/settings/team", panel: { title: "Invite team member", rows: ["{tech}", "Role: Admin"], hit: "Send invite" }, copy: "tech" },
  ],
  omnisend: [
    { title: "Open Users", body: "In **Omnisend**, click your store name › **Store settings** › **Users**.", url: "app.omnisend.com/settings/users", menu: ["Store settings", "  Store", "  Users", "  Billing"], active: "  Users", link: "https://app.omnisend.com/" },
    { title: "Invite Kaizen as an Admin", body: "Click **Invite user**, paste our address, pick **Admin**, and **Send invite**.", url: "app.omnisend.com/settings/users", panel: { title: "Invite user", rows: ["{tech}", "Access: Admin"], hit: "Send invite" }, copy: "tech" },
  ],
  "email-other": [{ title: "Add Kaizen as an admin", body: "In your email or SMS platform's settings, find **Users** or **Team**, and invite our address with **admin** access. Tell us the platform below.", url: "your email platform", hit: "Invite user", copy: "tech" }],
};

/** The addresses filled in */
export function fillAddress(text: string, a: { tech: string; klaviyo: string }) {
  return text.replace(/\{tech\}/g, a.tech).replace(/\{klaviyo\}/g, a.klaviyo);
}

/** A platform's steps as plain text, for the setup help to read */
export function stepsText(key: string, a: { tech: string; klaviyo: string }) {
  return (PLATFORM_STEPS[key] ?? []).map((s, i) => `${i + 1}. ${s.title}: ${fillAddress(s.body, a).replace(/\*\*/g, "")}${s.copy ? ` (address: ${s.copy === "klaviyo" ? a.klaviyo : a.tech})` : ""}`).join("\n");
}
