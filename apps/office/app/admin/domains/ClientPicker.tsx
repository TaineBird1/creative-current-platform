"use client";

import { useState } from "react";
import type { Id } from "@cc/convex/dataModel";
import { DomainWizard } from "./DomainWizard";
import s from "./domains.module.css";

type Client = {
  _id: Id<"clients">;
  name: string;
  slug: string | null;
  kind: "platform" | "external";
  status: string;
  isSeed: boolean;
  domainCount: number;
  liveDomain: string | null;
};

/**
 * Pick a client, then work on its domains. A list rather than a dropdown:
 * the domain state per client IS the information, and hiding it behind a
 * select would mean opening every one to find the one that needs attention.
 */
export function ClientPicker({ clients }: { clients: Client[] }) {
  const [selected, setSelected] = useState<Client | null>(null);

  // External clients have no site and never get a domain here.
  const eligible = clients.filter((c) => c.kind === "platform");

  if (eligible.length === 0) {
    return (
      <div className={s.empty}>
        <p className={s.emptyHeading}>No platform clients yet.</p>
        <p className={s.hint}>
          Domains attach to a client&rsquo;s site. Onboard a client first.
        </p>
      </div>
    );
  }

  if (selected) {
    return (
      <>
        <button type="button" className={s.back} onClick={() => setSelected(null)}>
          ← All clients
        </button>
        <h2 className={s.clientHeading}>
          {selected.name}
          {selected.isSeed ? <span className={s.badge}>seed</span> : null}
        </h2>
        <DomainWizard clientId={selected._id} clientName={selected.name} />
      </>
    );
  }

  return (
    <ul className={s.clients}>
      {eligible.map((client) => (
        <li key={client._id}>
          <button type="button" className={s.clientRow} onClick={() => setSelected(client)}>
            <span className={s.clientName}>
              {client.name}
              {client.isSeed ? <span className={s.badge}>seed</span> : null}
            </span>
            <span className={s.clientSlug}>/{client.slug ?? "—"}</span>
            <span className={s.clientDomain}>
              {client.liveDomain ? (
                <span className={s.live}>{client.liveDomain}</span>
              ) : client.domainCount > 0 ? (
                <span className={s.pending}>
                  {client.domainCount} pending
                </span>
              ) : (
                <span className={s.none}>no domain</span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
