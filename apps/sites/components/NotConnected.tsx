import h from "./holding.module.css";

/**
 * Development-only state: the app is running but no Convex deployment is
 * configured, so there is no tenant to resolve. Distinct from HoldingPage on
 * purpose — that one is what a client's CUSTOMER sees and must never mention
 * infrastructure. This one is for whoever is running the repo.
 */
export function NotConnected() {
  return (
    <div className="world-client">
      <main className={h.wrap}>
        <div className={h.inner}>
          <p className={h.name}>apps/sites</p>
          <h1 className={h.heading}>No backend configured.</h1>
          <p className={h.body}>
            Set <code>CONVEX_URL</code> to resolve real tenants. Run{" "}
            <code>npx convex dev</code> once to create a deployment and generate
            types. The template preview does not need a backend and is at{" "}
            <a href="/preview">/preview</a>.
          </p>
        </div>
      </main>
    </div>
  );
}
