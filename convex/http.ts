import { httpRouter } from "convex/server";
import { auth } from "./auth";

/**
 * PUBLIC, UNAUTHENTICATED. On the PUBLIC_ALLOWLIST in guards.test.ts.
 *
 * Auth's own routes must exist before a session does. Provider webhooks
 * (Paystack, Paddle) will land here too when M5 arrives — verified by
 * signature rather than by session, which is why this file is allowlisted.
 */
const http = httpRouter();
auth.addHttpRoutes(http);

export default http;
