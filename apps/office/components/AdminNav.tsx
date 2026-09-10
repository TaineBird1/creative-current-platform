"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ADMIN_SCREENS } from "./admin-screens";
import s from "./admin-nav.module.css";

/**
 * MOVING BETWEEN ADMIN SCREENS.
 *
 * Added because there was no way to. `/admin/queue` shipped with no link to
 * it anywhere — reachable only by typing the URL, which the person using it
 * was quietly doing. A screen nobody can navigate to is most of the way to a
 * screen that does not exist.
 *
 * Distinct from the venture switcher on the console page, which looks similar
 * and is not: that filters what you are looking at, this changes what you are
 * looking at. Keeping them apart is why this sits in the top bar and the
 * switcher stays under the heading.
 *
 * The list itself lives in `admin-screens.ts` so `admin-nav.test.ts` can
 * import it. Rendering it is not the same as listing it — this component
 * rendered nothing on the console for as long as the console forgot to place
 * it — so the two are guarded separately.
 */
export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav className={s.nav} aria-label="Admin sections">
      {ADMIN_SCREENS.map((screen) => {
        /*
         * Exact match for /admin, prefix for the rest — otherwise "Clients"
         * would light up on every page, since every path starts with /admin.
         */
        const active =
          screen.href === "/admin" ? pathname === "/admin" : pathname.startsWith(screen.href);
        return (
          <Link
            key={screen.href}
            href={screen.href}
            className={s.link}
            aria-current={active ? "page" : undefined}
          >
            {screen.label}
          </Link>
        );
      })}
    </nav>
  );
}
