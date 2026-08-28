/**
 * The file where the "silently always signed out" bug lives if it is wrong.
 *
 * `domain` must match the deployment's own CONVEX_SITE_URL — the issuer of the
 * JWTs Convex Auth mints. Convex sets CONVEX_SITE_URL on every deployment, so
 * reading it is safer than writing the URL down twice.
 */
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
