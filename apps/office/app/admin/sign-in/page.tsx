import { SignIn } from "@/components/SignIn";

/** The owner console's door. Monochrome — no client colour ever reaches /admin. */
export default function AdminSignIn() {
  return <SignIn world="admin" redirectTo="/admin" />;
}
