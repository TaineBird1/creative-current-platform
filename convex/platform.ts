import { internalQuery } from "./_generated/server";
import { platformQuery } from "./lib/functions";
import { requirePlatform } from "./lib/tenancy";

/**
 * Who am I on the platform side? The owner console calls this to decide
 * whether to render at all — /admin is not a page a tenant user may see, and
 * a session alone is not evidence of platform access.
 */
export const me = platformQuery({
  args: {},
  handler: async (ctx) => ({ role: ctx.platform.role }),
});

/**
 * The same check, reachable from an ACTION.
 *
 * Actions have no ctx.db, so they cannot run requirePlatform themselves —
 * but they do carry the caller's identity into runQuery, so this closes the
 * gap. Without it an action is an unauthenticated public endpoint, which is
 * exactly what guards.test.ts caught.
 */
export const requireCaller = internalQuery({
  args: {},
  handler: async (ctx) => requirePlatform(ctx, "operator"),
});
