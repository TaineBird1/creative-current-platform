"use client";

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@cc/convex/api";
import type { Id } from "@cc/convex/dataModel";
import s from "./issuer.module.css";

/**
 * SETTING AND CONFIRMING WHO ISSUES AN INVOICE.
 *
 * `issueInvoiceFor` refuses an unconfirmed issuer, and `convertWonDeal`
 * checks it BEFORE writing anything — so until this screen has been finished
 * once, onboarding a client refuses outright. That made it the last thing
 * standing between a paying customer and a back office, reachable only
 * through an `ownerMutation` that the CLI cannot authenticate to.
 *
 * THREE RULES LIVE IN THE BACKEND AND ARE SURFACED HERE BEFORE THEY BITE,
 * rather than reported as errors afterwards. Each one is invisible in a plain
 * form and expensive to discover on a real document:
 *
 *   1. EVERY EDIT CLEARS CONFIRMATION. Said above the form while the row is
 *      confirmed, because finding out afterwards means discovering that
 *      invoicing has silently switched itself off.
 *   2. THE BANK BLOCK IS ALL FOUR FIELDS OR NONE. `InvoiceDocument` prints
 *      nothing unless every one is present — a half-printed block is worse
 *      than none — so three-of-four is a document with nowhere to pay, which
 *      no validator would object to and no error would report.
 *   3. A VAT NUMBER IS NOT A FORMALITY. Absent means no VAT line, which is
 *      correct while unregistered. It is shape-checked on the server; the
 *      note here says why leaving it blank is the right answer.
 *
 * The form does NOT re-implement the server's validation. It sends, and shows
 * what came back — the backend is the only thing that knows the rules, and a
 * second copy in the browser is a second thing to keep in step.
 */

export type IssuerRow = {
  legalName: string;
  tradingName?: string;
  registrationNumber?: string;
  vatNumber?: string;
  addressLine: string;
  suburb?: string;
  city: string;
  postalCode?: string;
  email: string;
  phone?: string;
  bankName?: string;
  bankAccountName?: string;
  bankAccountNumber?: string;
  bankBranchCode?: string;
  confirmed: boolean;
  confirmedAt?: number;
} | null;

type Fields = {
  legalName: string;
  tradingName: string;
  registrationNumber: string;
  vatNumber: string;
  addressLine: string;
  suburb: string;
  city: string;
  postalCode: string;
  email: string;
  phone: string;
  bankName: string;
  bankAccountName: string;
  bankAccountNumber: string;
  bankBranchCode: string;
};

const from = (issuer: IssuerRow): Fields => ({
  legalName: issuer?.legalName ?? "",
  tradingName: issuer?.tradingName ?? "",
  registrationNumber: issuer?.registrationNumber ?? "",
  vatNumber: issuer?.vatNumber ?? "",
  addressLine: issuer?.addressLine ?? "",
  suburb: issuer?.suburb ?? "",
  city: issuer?.city ?? "",
  postalCode: issuer?.postalCode ?? "",
  email: issuer?.email ?? "",
  phone: issuer?.phone ?? "",
  bankName: issuer?.bankName ?? "",
  bankAccountName: issuer?.bankAccountName ?? "",
  bankAccountNumber: issuer?.bankAccountNumber ?? "",
  bankBranchCode: issuer?.bankBranchCode ?? "",
});

const BANK_KEYS = [
  "bankName",
  "bankAccountName",
  "bankAccountNumber",
  "bankBranchCode",
] as const;

export function IssuerForm({
  ventureId,
  issuer,
}: {
  ventureId: Id<"ventures">;
  issuer: IssuerRow;
}) {
  const save = useMutation(api.issuer.set);
  const confirm = useMutation(api.issuer.confirm);

  const [fields, setFields] = useState<Fields>(() => from(issuer));
  const [typedName, setTypedName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const set = (patch: Partial<Fields>) => {
    setFields((f) => ({ ...f, ...patch }));
    setSaved(false);
    setError(null);
  };

  const trimmed = (key: keyof Fields) => fields[key].trim();

  /*
   * All four or none. Counted rather than checked one by one, so the warning
   * can say how many are missing instead of naming the first.
   */
  const bankFilled = BANK_KEYS.filter((k) => trimmed(k) !== "").length;
  const bankPartial = bankFilled > 0 && bankFilled < BANK_KEYS.length;

  /*
   * "Dirty" is compared against the row as it stands, because that is what
   * decides whether saving will clear an existing confirmation. A form
   * reopened and not touched must not warn about a consequence it will not
   * cause.
   */
  const dirty = useMemo(() => {
    const original = from(issuer);
    return (Object.keys(original) as (keyof Fields)[]).some(
      (k) => original[k].trim() !== fields[k].trim(),
    );
  }, [issuer, fields]);

  async function run(action: () => Promise<unknown>, onDone?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onDone?.();
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

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void run(
      () =>
        save({
          ventureId,
          legalName: trimmed("legalName"),
          tradingName: trimmed("tradingName") || undefined,
          registrationNumber: trimmed("registrationNumber") || undefined,
          vatNumber: trimmed("vatNumber") || undefined,
          addressLine: trimmed("addressLine"),
          suburb: trimmed("suburb") || undefined,
          city: trimmed("city"),
          postalCode: trimmed("postalCode") || undefined,
          email: trimmed("email"),
          phone: trimmed("phone") || undefined,
          bankName: trimmed("bankName") || undefined,
          bankAccountName: trimmed("bankAccountName") || undefined,
          bankAccountNumber: trimmed("bankAccountNumber") || undefined,
          bankBranchCode: trimmed("bankBranchCode") || undefined,
        }),
      () => setSaved(true),
    );
  };

  return (
    <>
      <form className={s.form} onSubmit={submit}>
        {issuer?.confirmed && dirty ? (
          <p className={s.warn}>
            Saving this clears the confirmation, and nothing can be invoiced
            until you confirm again. That is deliberate — what was approved is
            no longer what would print.
          </p>
        ) : null}

        <Group
          title="Who is issuing"
          note="A sole proprietor invoices in their own name. There is nothing to register and nothing to wait for — the legal person is you."
        >
          <Field
            label="Full legal name"
            wide
            value={fields.legalName}
            onChange={(v) => set({ legalName: v })}
            placeholder="Your own full name, as it appears on your ID"
            note="This prints at the top of every invoice. It is the one field nothing else can catch if it is wrong."
          />
          <Field
            label="Trading name"
            optional
            value={fields.tradingName}
            onChange={(v) => set({ tradingName: v })}
            placeholder="The Creative Current"
            note="Printed as 't/a' under your name."
          />
          <Field
            label="Registration number"
            optional
            value={fields.registrationNumber}
            onChange={(v) => set({ registrationNumber: v })}
            mono
            note="Only once a company exists. Blank is the ordinary case, not a gap."
          />
          <Field
            label="VAT number"
            optional
            wide
            value={fields.vatNumber}
            onChange={(v) => set({ vatNumber: v })}
            mono
            note="Leave blank until you are registered. Invoices then carry no VAT line, which is correct — charging VAT you are not registered for is a much worse problem than not charging it."
          />
        </Group>

        <Group
          title="Where you are"
          note="An address a client can write to, and a mailbox that reaches you."
        >
          <Field
            label="Street address"
            wide
            value={fields.addressLine}
            onChange={(v) => set({ addressLine: v })}
          />
          <Field
            label="Suburb"
            optional
            value={fields.suburb}
            onChange={(v) => set({ suburb: v })}
          />
          <Field label="City" value={fields.city} onChange={(v) => set({ city: v })} />
          <Field
            label="Postal code"
            optional
            value={fields.postalCode}
            onChange={(v) => set({ postalCode: v })}
            mono
          />
          <Field
            label="Email"
            type="email"
            value={fields.email}
            onChange={(v) => set({ email: v })}
            note="Where a client replies about a bill."
          />
          <Field
            label="Phone"
            optional
            type="tel"
            value={fields.phone}
            onChange={(v) => set({ phone: v })}
            mono
          />
        </Group>

        <Group
          title="Where to pay"
          note="Read live at the moment an invoice is opened, never snapshotted — a closed account must not keep collecting payments from documents already sent."
        >
          {bankPartial ? (
            <p className={s.warn}>
              {BANK_KEYS.length - bankFilled === 1
                ? "One of these four is still empty"
                : `${BANK_KEYS.length - bankFilled} of these four are still empty`}
              , and the invoice prints all four or none. As it stands a client
              would open the document and find nowhere to pay.
            </p>
          ) : null}
          <Field
            label="Bank"
            optional
            value={fields.bankName}
            onChange={(v) => set({ bankName: v })}
          />
          <Field
            label="Account name"
            optional
            value={fields.bankAccountName}
            onChange={(v) => set({ bankAccountName: v })}
          />
          <Field
            label="Account number"
            optional
            mono
            value={fields.bankAccountNumber}
            onChange={(v) => set({ bankAccountNumber: v })}
          />
          <Field
            label="Branch code"
            optional
            mono
            value={fields.bankBranchCode}
            onChange={(v) => set({ bankBranchCode: v })}
          />
        </Group>

        <div className={s.actions}>
          <button className={s.primary} type="submit" disabled={busy}>
            {busy ? "Saving…" : issuer ? "Save changes" : "Save details"}
          </button>
          {saved ? <p className={s.ok}>Saved.</p> : null}
          {error ? <p className={s.error}>{error}</p> : null}
        </div>
      </form>

      <Preview fields={fields} bankFilled={bankFilled} />

      {issuer && !issuer.confirmed ? (
        <section className={s.confirm} aria-labelledby="confirm-heading">
          <h2 className={s.confirmTitle} id="confirm-heading">
            Confirm these details
          </h2>
          <p className={s.confirmBody}>
            Type the legal name exactly as it appears above. Not a checkbox —
            a box can be ticked without reading, and the thing being guarded
            against is a name nobody read. Nothing can be invoiced until this
            is done.
          </p>
          <div className={s.confirmRow}>
            <label className={s.field}>
              <span className={s.label}>Legal name</span>
              <input
                className={`${s.control}`}
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
                autoComplete="off"
                placeholder={issuer.legalName}
              />
            </label>
            <button
              className={s.primary}
              type="button"
              disabled={busy || typedName.trim() === ""}
              onClick={() =>
                void run(() =>
                  confirm({ ventureId, legalName: typedName.trim() }),
                )
              }
            >
              {busy ? "Confirming…" : "Confirm"}
            </button>
          </div>
          {error ? <p className={s.error}>{error}</p> : null}
        </section>
      ) : null}
    </>
  );
}

function Group({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className={s.group}>
      <div className={s.groupHead}>
        <h2 className={s.groupTitle}>{title}</h2>
        <p className={s.groupNote}>{note}</p>
      </div>
      <div className={s.grid}>{children}</div>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  optional,
  wide,
  mono,
  type,
  placeholder,
  note,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  optional?: boolean;
  wide?: boolean;
  mono?: boolean;
  type?: string;
  placeholder?: string;
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
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {note ? <p className={s.fieldNote}>{note}</p> : null}
    </label>
  );
}

/**
 * WHAT A CLIENT WILL ACTUALLY SEE.
 *
 * The confirmation regime exists to stop a plausible-but-invented name
 * printing on a document somebody keeps. Asking a person to vouch for values
 * they have only seen as form inputs is asking them to vouch for the wrong
 * thing — so the block is rendered the way the invoice renders it, from the
 * live field values, before the confirm button is reached.
 */
function Preview({ fields, bankFilled }: { fields: Fields; bankFilled: number }) {
  const line = (v: string) => v.trim();
  const has = Boolean(line(fields.legalName));

  return (
    <section className={s.preview} aria-label="What prints on an invoice">
      <p className={s.previewLabel}>What prints on the invoice</p>
      <div className={s.paper}>
        <div>
          <h3 className={s.paperName}>
            {has ? line(fields.legalName) : "— no legal name yet —"}
          </h3>
          {line(fields.tradingName) ? (
            <p className={s.paperLine}>t/a {line(fields.tradingName)}</p>
          ) : null}
          {line(fields.addressLine) ? (
            <p className={s.paperLine}>
              {line(fields.addressLine)}
              {line(fields.suburb) ? `, ${line(fields.suburb)}` : ""}
            </p>
          ) : null}
          {line(fields.city) ? (
            <p className={s.paperLine}>
              {line(fields.city)}
              {line(fields.postalCode) ? ` ${line(fields.postalCode)}` : ""}
            </p>
          ) : null}
          {line(fields.email) ? (
            <p className={s.paperLine}>{line(fields.email)}</p>
          ) : null}
          {line(fields.phone) ? (
            <p className={s.paperLine}>{line(fields.phone)}</p>
          ) : null}
          {line(fields.registrationNumber) ? (
            <p className={s.paperLine}>Reg. {line(fields.registrationNumber)}</p>
          ) : null}
          {line(fields.vatNumber) ? (
            <p className={s.paperLine}>VAT {line(fields.vatNumber)}</p>
          ) : null}
        </div>

        <div className={s.paperBank}>
          {bankFilled === BANK_KEYS.length ? (
            <>
              <Row label="Bank" value={line(fields.bankName)} />
              <Row label="Account name" value={line(fields.bankAccountName)} />
              <Row label="Account number" value={line(fields.bankAccountNumber)} />
              <Row label="Branch code" value={line(fields.bankBranchCode)} />
            </>
          ) : (
            <p className={s.paperMissing}>
              No payment details print — the invoice needs all four bank fields
              or it shows none.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <dl className={s.paperBankRow}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </dl>
  );
}
