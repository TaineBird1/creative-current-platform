import { platformQuery } from "./lib/functions";

/**
 * Who am I on the platform side? The owner console calls this to decide
 * whether to render at all — /admin is not a page a tenant user may see, and
 * a session alone is not evidence of platform access.
 */
export const me = platformQuery({
  args: {},
  handler: async (ctx) => ({ role: ctx.platform.role }),
});
