/**
 * The convex-test harness passes its modules via Vite's `import.meta.glob`,
 * which Convex's own typecheck does not know about — and `vite/client` is not
 * resolvable from here under pnpm, since vite is a transitive dependency and
 * is not hoisted. Declaring the one member we use keeps both `convex dev` and
 * `tsc` green without depending on hoisting.
 */
interface ImportMeta {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}
