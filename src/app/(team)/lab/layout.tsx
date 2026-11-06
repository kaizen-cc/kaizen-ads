import { keepCreativeOut } from "@/lib/auth";

// The Ads Lab is a media-buying table: the creative team goes home instead
export default async function LabLayout({ children }: LayoutProps<"/lab">) {
  await keepCreativeOut("lab");
  return children;
}
