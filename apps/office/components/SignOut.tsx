"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import s from "./sign-in.module.css";

export function SignOut() {
  const { signOut } = useAuthActions();
  return (
    <button type="button" className={s.link} onClick={() => void signOut()}>
      Sign out
    </button>
  );
}
