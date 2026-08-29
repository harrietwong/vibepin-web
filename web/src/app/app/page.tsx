import { redirect } from "next/navigation";
import AdminForbiddenNotice from "@/components/app/AdminForbiddenNotice";

type AppRootProps = {
  searchParams: Promise<{ admin?: string }>;
};

export default async function AppRoot({ searchParams }: AppRootProps) {
  const { admin } = await searchParams;

  // Admin pages intentionally redirect rejected users to this exact URL. Keep
  // it terminal so the reason is not erased by the normal /app -> Studio hop.
  if (admin === "forbidden") return <AdminForbiddenNotice />;

  redirect("/app/studio");
}
