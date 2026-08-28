export default function Index() {
  return (
    <main className="world-client" style={{ padding: "var(--space-2xl)" }}>
      <div className="shell prose">
        <h1>apps/sites</h1>
        <p style={{ color: "var(--text-muted)", marginTop: "var(--space-s)" }}>
          Public client websites are served by host or slug. With no backend
          configured, the template preview is at{" "}
          <a href="/preview">/preview</a>.
        </p>
      </div>
    </main>
  );
}
