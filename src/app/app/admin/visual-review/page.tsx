import { redirect } from "next/navigation";

// Moved to the standalone internal admin console at /admin/visual-review.
export default function OldVisualReviewRedirect() {
  redirect("/admin/visual-review");
}
