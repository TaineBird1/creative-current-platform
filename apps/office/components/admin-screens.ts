/**
 * THE ADMIN SECTIONS, IN A MODULE OF THEIR OWN.
 *
 * Same reason `lib/public-routes.ts` exists: a list a guard has to IMPORT is a
 * list a guard can actually check. The alternative was regex-scanning
 * `AdminNav.tsx` for hrefs, which is the inference rung of the ladder — a
 * paragraph explaining the nav would satisfy it, and that exact trick has
 * fooled three guards in this repo already.
 *
 * Ordered by how often it is opened, not alphabetically or by module. Queue
 * first because it is opened every morning; Invoicing last because it is
 * opened once and then almost never.
 */
export const ADMIN_SCREENS = [
  { href: "/admin/queue", label: "Queue" },
  { href: "/admin/tasks", label: "Inbox" },
  { href: "/admin", label: "Clients" },
  { href: "/admin/finance", label: "Money" },
  { href: "/admin/leads/import", label: "Import leads" },
  { href: "/admin/clients/new", label: "Add client" },
  { href: "/admin/domains", label: "Domains" },
  /*
   * A screen nobody can navigate to is most of the way to a screen that does
   * not exist. `/admin/queue` shipped with no link to it anywhere, and
   * `/admin/issuer` shipped with a link that rendered only on the refusal
   * screen — present where it was useless, absent where it worked. Both were
   * found by a person typing a URL rather than by anything failing.
   */
  { href: "/admin/issuer", label: "Invoicing" },
] as const;

/**
 * The one admin page that deliberately has no nav: it is served to somebody
 * with no session, so every link on it would refuse. Named here rather than
 * inferred from the absence of a top bar, so the exception is a decision
 * somebody wrote down.
 */
export const ADMIN_ROUTES_WITHOUT_NAV = ["/admin/sign-in"] as const;
