"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@cc/convex/api";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "@cc/convex/dataModel";
import s from "./domains.module.css";

type Props = { clientId: Id<"clients">; clientName: string };

/**
 * Derived from the query rather than hand-written, so a change to
 * domains.forClient breaks this file instead of silently drifting from it.
 */
type WizardView = FunctionReturnType<typeof api.domains.forClient>;
type Domain = WizardView["domains"][number];
type Record_ = Domain["records"][number];

/**
 * THE DOMAIN WIZARD.
 *
 * Operate mode: the operator is mid-task, on a call with a client who is
 * looking at their registrar. So the screen optimises for one thing — getting
 * correct, copyable instructions out of here and into the client's hands —
 * and states the truth about what has and has not happened upstream.
 *
 * Every state is real: idle, working, claimed-but-unverified, live, and
 * "no Vercel token, instructions are still valid".
 */
export function DomainWizard({ clientId, clientName }: Props) {
  const view = useQuery(api.domains.forClient, { clientId });
  const claim = useMutation(api.domains.claim);
  const attach = useAction(api.domains.attach);
  const refresh = useAction(api.domains.refresh);

  const [hostname, setHostname] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  if (view === undefined) {
    // Skeleton, not a spinner: the shape of what is coming.
    return (
      <div className={s.skeleton} aria-busy="true" aria-label="Loading domains">
        <span className={s.skeletonLine} />
        <span className={s.skeletonLine} data-short="true" />
      </div>
    );
  }

  async function addDomain(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy("claim");
    try {
      const { domainId } = await claim({ clientId, hostname });
      setHostname("");
      // Claim and attach are separate on the backend so the transaction does
      // not depend on Vercel being reachable. The operator sees one action.
      await attach({ domainId });
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(null);
    }
  }

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
    } catch {
      setError("Could not copy. Select the text and copy it manually.");
    }
  }

  return (
    <div className={s.wizard}>
      {!view.hasSite ? (
        <p className={s.blocked}>
          {clientName} has no site yet. Create the site before attaching a domain
          — a domain pointing at nothing is worse than no domain.
        </p>
      ) : (
        <>
          {!view.sitePublished ? (
            <p className={s.warn}>
              The site exists but is not published. The domain can be set up now;
              it will show a holding page until you publish.
            </p>
          ) : null}

          {!view.vercelConfigured ? (
            <p className={s.warn}>
              No Vercel token is configured, so domains are recorded here but not
              attached upstream. The DNS records below are still correct — send
              them to the client now, and attach once the token is set.
            </p>
          ) : null}

          <form className={s.addForm} onSubmit={addDomain}>
            <div className={s.field}>
              <label className={s.label} htmlFor="hostname">
                Add a domain
              </label>
              <input
                id="hostname"
                className={s.control}
                value={hostname}
                placeholder="renusolar.co.za"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "domain-error" : "domain-hint"}
                onChange={(e) => {
                  setHostname(e.target.value);
                  setError(null);
                }}
              />
              <p className={s.hint} id="domain-hint">
                Paste it however the client sent it. https:// and trailing
                slashes are stripped.
              </p>
            </div>
            <button className={s.primary} type="submit" disabled={busy !== null || !hostname.trim()}>
              {busy === "claim" ? "Adding…" : "Add"}
            </button>
          </form>

          {error ? (
            <p className={s.error} id="domain-error" role="alert">
              {error}
            </p>
          ) : null}

          {view.domains.length === 0 ? (
            <div className={s.empty}>
              <p className={s.emptyHeading}>No domain yet.</p>
              <p className={s.hint}>
                Add the client&rsquo;s domain above. You will get DNS records and a
                plain-text sheet to send them — they do the rest at their
                registrar, and the certificate issues itself.
              </p>
            </div>
          ) : (
            <ol className={s.list}>
              {view.domains.map((domain: Domain) => (
                <li className={s.domain} key={domain._id}>
                  <div className={s.domainHead}>
                    <div>
                      <p className={s.hostname}>{domain.hostname}</p>
                      <p className={s.status} data-state={domain.verificationStatus}>
                        {statusLabel(domain.verificationStatus, view.vercelConfigured)}
                      </p>
                    </div>
                    <button
                      type="button"
                      className={s.secondary}
                      disabled={busy !== null || !view.vercelConfigured}
                      onClick={async () => {
                        setBusy(domain._id);
                        setError(null);
                        try {
                          await refresh({ domainId: domain._id });
                        } catch (caught) {
                          setError(readableError(caught));
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      {busy === domain._id ? "Checking…" : "Check DNS"}
                    </button>
                  </div>

                  <table className={s.records}>
                    <thead>
                      <tr>
                        <th scope="col">Type</th>
                        <th scope="col">Host</th>
                        <th scope="col">Points to</th>
                      </tr>
                    </thead>
                    <tbody>
                      {domain.records.map((record: Record_) => (
                        <tr key={`${record.type}-${record.name}`}>
                          <td className="tabular">{record.type}</td>
                          <td className="tabular">{record.name}</td>
                          <td className="tabular">{record.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div className={s.actions}>
                    <button
                      type="button"
                      className={s.secondary}
                      onClick={() => copy(domain.onePager, `sheet-${domain._id}`)}
                    >
                      {copied === `sheet-${domain._id}` ? "Copied" : "Copy the sheet to send"}
                    </button>
                  </div>

                  <details className={s.preview}>
                    <summary className={s.previewSummary}>What they will receive</summary>
                    <pre className={s.sheet}>{domain.onePager}</pre>
                  </details>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

function statusLabel(status: string, vercelConfigured: boolean): string {
  if (!vercelConfigured) return "Recorded here, not attached upstream";
  if (status === "verified") return "Live";
  if (status === "failed") return "DNS is not right yet";
  return "Waiting on DNS";
}

/**
 * Convex wraps thrown errors; the useful sentence is inside. An operator
 * mid-call needs "that domain belongs to another client", not a stack.
 */
function readableError(caught: unknown): string {
  const raw = caught instanceof Error ? caught.message : String(caught);
  const match = raw.match(/"message":"([^"]+)"/) ?? raw.match(/Error: (.+?)(\n|$)/);
  return match?.[1] ?? "That did not work. Check the domain and try again.";
}
