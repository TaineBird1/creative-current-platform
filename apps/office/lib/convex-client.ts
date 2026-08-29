"use client";

import { ConvexReactClient } from "convex/react";

/**
 * The office runs a browser client, unlike apps/sites: auth needs a live
 * session and the back office is a real application rather than a page.
 */
export const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
