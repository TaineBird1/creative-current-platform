/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  transpilePackages: ["@cc/site-config", "@cc/tokens"],
  experimental: { optimizePackageImports: ["@cc/site-config"] },
};
