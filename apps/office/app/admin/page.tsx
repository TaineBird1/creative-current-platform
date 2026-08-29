import { SignOut } from "@/components/SignOut";

/**
 * The owner console at its M1 size. The lead engine, fleet view, pipeline and
 * finance are M4+; this exists so /admin is not a 404 behind the sign-in.
 * Monochrome — no client colour reaches this world.
 */
export default function Admin() {
  return (
    <div className="world-admin">
      <main style={{ padding: "var(--space-xl) var(--space-m)", minHeight: "100dvh" }}>
        <div style={{ maxWidth: "42ch" }}>
          <h1 style={{ fontFamily: "var(--font-display)", fontSize: "var(--step-2)", margin: 0 }}>
            Admin
          </h1>
          <p style={{ color: "var(--text-muted)", marginTop: "var(--space-s)" }}>
            Signed in. The console itself is M4 — lead engine, pipeline, fleet
            and finance. Client back offices are at <code>/c/&lt;slug&gt;</code>.
          </p>
          <div style={{ marginTop: "var(--space-m)" }}>
            <SignOut />
          </div>
        </div>
      </main>
    </div>
  );
}
