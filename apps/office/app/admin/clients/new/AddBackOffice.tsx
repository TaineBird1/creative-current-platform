"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@cc/convex/api";
import { buildAccentRamp } from "@cc/site-config";
import type { Id } from "@cc/convex/dataModel";
import s from "./new-client.module.css";

/**
 * ONBOARD A CLIENT WHOSE WEBSITE IS NOT OURS.
 *
 * `onboarding.addBackOffice` is an `ownerMutation`, so the CLI cannot
 * authenticate to it and there is no other way in. Without this screen the
 * mutation exists and cannot be called by anybody — the same state the issuer
 * was in, and the reason the first paying client could not be onboarded.
 *
 * THE ENQUIRY FIELDS ARE THE POINT OF THE FORM, not an afterthought. They are
 * the server's declaration of the client's form: which fields exist, which
 * are required, and what may be answered. Their own site renders whatever
 * markup it likes and `public/quote.ts` validates against THIS.
 */

type Kind = "text" | "longtext" | "number" | "select" | "dateRange";

type FieldRow = {
  key: string;
  label: string;
  kind: Kind;
  required: boolean;
  /** Newline-separated in the textarea; split on submit. */
  options: string;
};

const KINDS: { value: Kind; label: string }[] = [
  { value: "text", label: "Short text" },
  { value: "longtext", label: "Long text" },
  { value: "number", label: "Number" },
  { value: "select", label: "Choose one" },
  { value: "dateRange", label: "Date range" },
];

const emptyField = (): FieldRow => ({
  key: "",
  label: "",
  kind: "text",
  required: false,
  options: "",
});

type Venture = { _id: string; name: string };

export function AddBackOffice({ ventures }: { ventures: Venture[] }) {
  const add = useMutation(api.onboarding.addBackOffice);

  const [ventureId, setVentureId] = useState(ventures[0]?._id ?? "");
  const [businessName, setBusinessName] = useState("");
  const [slug, setSlug] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [brandColour, setBrandColour] = useState("#1f6f43");
  const [siteUrl, setSiteUrl] = useState("");

  const [locName, setLocName] = useState("Head office");
  const [suburb, setSuburb] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");

  const [heading, setHeading] = useState("Tell us what you have in mind");
  const [noticeText, setNoticeText] = useState("");
  const [marketingText, setMarketingText] = useState("");
  const [fields, setFields] = useState<FieldRow[]>([emptyField()]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    slug: string;
    signInUrl: string;
    enquirySectionId: string;
    inviteDelivery: string;
  } | null>(null);

  const editField = (index: number, patch: Partial<FieldRow>) =>
    setFields((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await add({
        ventureId: ventureId as Id<"ventures">,
        businessName: businessName.trim(),
        slug: slug.trim().toLowerCase(),
        ownerEmail: ownerEmail.trim(),
        primaryContactPhone: phone.trim() || undefined,
        brandColour,
        accent: buildAccentRamp(brandColour),
        externalSiteUrl: siteUrl.trim() || undefined,
        locations: [
          {
            id: "main",
            name: locName.trim() || "Head office",
            suburb: suburb.trim(),
            city: city.trim(),
            region: region.trim(),
          },
        ],
        enquiry: {
          heading: heading.trim(),
          noticeText: noticeText.trim(),
          marketingConsentText: marketingText.trim() || undefined,
          fields: fields
            .filter((row) => row.key.trim() && row.label.trim())
            .map((row) => ({
              key: row.key.trim(),
              label: row.label.trim(),
              kind: row.kind,
              required: row.required,
              options:
                row.kind === "select"
                  ? row.options.split("\n").map((o) => o.trim()).filter(Boolean)
                  : undefined,
            })),
        },
      });
      setDone({
        slug: result.slug,
        signInUrl: result.signInUrl,
        enquirySectionId: result.enquirySectionId,
        inviteDelivery: String(result.inviteDelivery),
      });
    } catch (caught) {
      const message =
        caught && typeof caught === "object" && "data" in caught
          ? (caught.data as { message?: string })?.message
          : undefined;
      setError(message ?? "That did not go through. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    /*
     * WHAT ACTUALLY HAPPENED, including the delivery outcome. Reporting
     * "invited" over a message the allowlist held is the failure the whole
     * outbox exists to make visible, and it would be the first thing this
     * screen got wrong.
     */
    const delivered = done.inviteDelivery === "queued" || done.inviteDelivery === "sent";
    return (
      <section className={s.done}>
        <h2 className={s.doneHeading}>{done.slug} is live</h2>

        <p className={delivered ? s.ok : s.warn}>
          {delivered
            ? `The invite is on its way to them. Delivery: ${done.inviteDelivery}.`
            : `The invite was NOT delivered — outcome: ${done.inviteDelivery}. Nothing has ` +
              `reached them. Check MESSAGING_ALLOWLIST on this deployment before telling ` +
              `them to sign in.`}
        </p>

        <dl className={s.facts}>
          <dt>They sign in at</dt>
          <dd className={s.mono}>{done.signInUrl}</dd>
          <dt>Their form posts with slug</dt>
          <dd className={s.mono}>{done.slug}</dd>
          <dt>and sectionId</dt>
          <dd className={s.mono}>{done.enquirySectionId}</dd>
        </dl>

        <p className={s.hint}>
          No invoice was issued and no deal was touched. If they still owe you
          for the build, that is a separate document.
        </p>
      </section>
    );
  }

  return (
    <form className={s.form} onSubmit={submit}>
      <section className={s.group}>
        <h2 className={s.groupTitle}>The client</h2>

        <div className={s.grid}>
          <label className={s.field}>
            <span className={s.label}>Venture</span>
            <select
              className={s.control}
              value={ventureId}
              onChange={(e) => setVentureId(e.target.value)}
            >
              {ventures.map((v) => (
                <option key={v._id} value={v._id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>

          <Text label="Business name" value={businessName} onChange={setBusinessName} />
          <Text
            label="Slug"
            value={slug}
            onChange={setSlug}
            mono
            note="Their back office lives at /c/<slug>. Refused if taken — never silently suffixed, because the URL is one you will have told them."
          />
          <Text
            label="Owner email"
            value={ownerEmail}
            onChange={setOwnerEmail}
            type="email"
            note="The invite goes here, and this is the address sign-in will recognise. Another one will not."
          />
          <Text label="Phone" value={phone} onChange={setPhone} optional />
          <label className={s.field}>
            <span className={s.label}>Brand colour</span>
            <input
              className={s.colour}
              type="color"
              value={brandColour}
              onChange={(e) => setBrandColour(e.target.value)}
            />
            <p className={s.fieldNote}>
              Their back office is tinted from this through the AA-safe ramp.
            </p>
          </label>
          <Text
            label="Their website"
            value={siteUrl}
            onChange={setSiteUrl}
            optional
            wide
            note="Recorded, never fetched. We do not serve their site."
          />
        </div>
      </section>

      <section className={s.group}>
        <h2 className={s.groupTitle}>Where they are</h2>
        <p className={s.groupNote}>
          A street address is optional on purpose — a business that publishes a
          suburb and no street has told you a suburb.
        </p>
        <div className={s.grid}>
          <Text label="Location name" value={locName} onChange={setLocName} />
          <Text label="Suburb" value={suburb} onChange={setSuburb} />
          <Text label="City" value={city} onChange={setCity} />
          <Text label="Province" value={region} onChange={setRegion} />
        </div>
      </section>

      <section className={s.group}>
        <h2 className={s.groupTitle}>Their enquiry form</h2>
        <p className={s.groupNote}>
          This is what the server will accept. Their own site renders the
          markup; required fields and the notice are enforced from here.
        </p>

        <div className={s.grid}>
          <Text label="Heading" value={heading} onChange={setHeading} wide />
          <Area
            label="Notice"
            value={noticeText}
            onChange={setNoticeText}
            note="Always shown, no checkbox. Answering an enquiry does not run on consent, so there is nothing to accept — this says what happens to the details."
          />
          <Area
            label="Marketing consent"
            value={marketingText}
            onChange={setMarketingText}
            optional
            note="One unticked box that never blocks submit. Leave blank for no box at all. Do not promise 'reply STOP' — nothing here can act on one."
          />
        </div>

        <ul className={s.fields}>
          {fields.map((row, index) => (
            <li className={s.fieldRow} key={index}>
              <Text label="Key" value={row.key} onChange={(v) => editField(index, { key: v })} mono />
              <Text label="Label" value={row.label} onChange={(v) => editField(index, { label: v })} />
              <label className={s.field}>
                <span className={s.label}>Kind</span>
                <select
                  className={s.control}
                  value={row.kind}
                  onChange={(e) => editField(index, { kind: e.target.value as Kind })}
                >
                  {KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className={s.check}>
                <input
                  type="checkbox"
                  checked={row.required}
                  onChange={(e) => editField(index, { required: e.target.checked })}
                />
                <span>Required</span>
              </label>
              {row.kind === "select" ? (
                <Area
                  label="Options"
                  value={row.options}
                  onChange={(v) => editField(index, { options: v })}
                  note="One per line."
                />
              ) : null}
              {fields.length > 1 ? (
                <button
                  type="button"
                  className={s.remove}
                  onClick={() => setFields((rows) => rows.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>

        <button
          type="button"
          className={s.secondary}
          onClick={() => setFields((rows) => [...rows, emptyField()])}
        >
          Add a field
        </button>
      </section>

      <div className={s.actions}>
        <button className={s.primary} type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create the back office"}
        </button>
        {error ? <p className={s.error}>{error}</p> : null}
      </div>
    </form>
  );
}

function Text({
  label, value, onChange, optional, wide, mono, type, note,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  optional?: boolean;
  wide?: boolean;
  mono?: boolean;
  type?: string;
  note?: string;
}) {
  return (
    <label className={`${s.field} ${wide ? s.wide : ""}`}>
      <span className={s.label}>
        {label}
        {optional ? <span className={s.optional}> — optional</span> : null}
      </span>
      <input
        className={`${s.control} ${mono ? s.mono : ""}`}
        type={type ?? "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {note ? <p className={s.fieldNote}>{note}</p> : null}
    </label>
  );
}

function Area({
  label, value, onChange, optional, note,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  optional?: boolean;
  note?: string;
}) {
  return (
    <label className={`${s.field} ${s.wide}`}>
      <span className={s.label}>
        {label}
        {optional ? <span className={s.optional}> — optional</span> : null}
      </span>
      <textarea className={s.area} value={value} onChange={(e) => onChange(e.target.value)} />
      {note ? <p className={s.fieldNote}>{note}</p> : null}
    </label>
  );
}
