"use client";

import { useId, useState } from "react";
import type { Section } from "@cc/site-config";
import { Band } from "./Blocks";
import s from "./sections.module.css";

type QuoteSection = Extract<Section, { type: "quote" }>;

/**
 * The conversion surface. Everything else on the page exists to get someone
 * here, so the rules are strict:
 *
 *   - name and phone are the ONLY required identity fields. No account, no
 *     email gate, no password, ever.
 *   - errors name the problem and the recovery, inline, next to the control
 *     that caused them, and clear the moment the field is edited.
 *   - the required set comes from the CONFIG, and the server re-derives it
 *     from the same config rather than trusting this component.
 */
export function QuoteForm({
  section,
  slug,
  onSubmit,
}: {
  section: QuoteSection;
  slug: string;
  onSubmit?: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const formId = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");

  const clear = (key: string) =>
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

  function validate() {
    const next: Record<string, string> = {};
    if (name.trim().length < 2) next.name = "Tell us who to ask for.";
    if (!/^\+?[0-9 ()-]{7,20}$/.test(phone.trim())) {
      next.phone = "We need a number we can actually call.";
    }
    for (const field of section.fields) {
      if (field.kind === "photos") continue;
      if (field.required && !values[field.key]?.trim()) {
        // Never interpolate the label into a sentence: half of them are
        // questions, and "What are we quoting? is needed" is not English.
        next[field.key] =
          field.kind === "select"
            ? "Pick one so we can price this."
            : "We need this to price the job.";
      }
    }
    if (!consent) next.consent = "We need your agreement before we can contact you.";
    return next;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      document.getElementById(`${formId}-${Object.keys(found)[0]}`)?.focus();
      return;
    }
    setState("sending");
    try {
      await onSubmit?.({ slug, sectionId: section.id, name, phone, answers: values, consentAccepted: consent });
      setState("sent");
    } catch {
      setState("idle");
      setErrors({ form: "That did not send. Try again, or phone us instead." });
    }
  }

  if (state === "sent") {
    return (
      <Band id={section.id} tone="accent" label={section.heading}>
        <h2 className={s.narrativeHeading}>Thanks — that is with us.</h2>
        <p className={s.success} role="status">
          {section.successMessage}
        </p>
      </Band>
    );
  }

  return (
    <Band id={section.id} tone="accent" label={section.heading}>
      <h2 className={s.narrativeHeading}>{section.heading}</h2>

      <form className={s.form} onSubmit={handleSubmit} noValidate>
        <div className={s.fieldRow} data-cols="2">
          <Field
            id={`${formId}-name`}
            label="Your name"
            error={errors.name}
          >
            <input
              id={`${formId}-name`}
              className={s.control}
              value={name}
              autoComplete="name"
              aria-invalid={Boolean(errors.name)}
              onChange={(e) => {
                setName(e.target.value);
                clear("name");
              }}
            />
          </Field>

          <Field id={`${formId}-phone`} label="Phone" error={errors.phone}>
            <input
              id={`${formId}-phone`}
              className={`${s.control} tabular`}
              value={phone}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="082 123 4567"
              aria-invalid={Boolean(errors.phone)}
              onChange={(e) => {
                setPhone(e.target.value);
                clear("phone");
              }}
            />
          </Field>
        </div>

        {section.fields
          .filter((f) => f.kind !== "photos")
          .map((field) => (
            <Field
              key={field.key}
              id={`${formId}-${field.key}`}
              label={field.label}
              optional={!field.required}
              error={errors[field.key]}
            >
              {field.kind === "select" ? (
                <select
                  id={`${formId}-${field.key}`}
                  className={s.control}
                  value={values[field.key] ?? ""}
                  aria-invalid={Boolean(errors[field.key])}
                  onChange={(e) => {
                    setValues((v) => ({ ...v, [field.key]: e.target.value }));
                    clear(field.key);
                  }}
                >
                  <option value="">Choose one</option>
                  {(field.options ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : field.kind === "longtext" ? (
                <textarea
                  id={`${formId}-${field.key}`}
                  className={s.control}
                  value={values[field.key] ?? ""}
                  aria-invalid={Boolean(errors[field.key])}
                  onChange={(e) => {
                    setValues((v) => ({ ...v, [field.key]: e.target.value }));
                    clear(field.key);
                  }}
                />
              ) : (
                <input
                  id={`${formId}-${field.key}`}
                  className={s.control}
                  value={values[field.key] ?? ""}
                  inputMode={field.kind === "number" ? "numeric" : "text"}
                  aria-invalid={Boolean(errors[field.key])}
                  onChange={(e) => {
                    setValues((v) => ({ ...v, [field.key]: e.target.value }));
                    clear(field.key);
                  }}
                />
              )}
            </Field>
          ))}

        <div>
          <label className={s.consent} htmlFor={`${formId}-consent`}>
            <input
              id={`${formId}-consent`}
              type="checkbox"
              checked={consent}
              aria-invalid={Boolean(errors.consent)}
              onChange={(e) => {
                setConsent(e.target.checked);
                clear("consent");
              }}
            />
            <span>{section.consentText}</span>
          </label>
          {errors.consent ? (
            <p className={s.error} role="alert">
              {errors.consent}
            </p>
          ) : null}
        </div>

        {errors.form ? (
          <p className={s.error} role="alert">
            {errors.form}
          </p>
        ) : null}

        <div>
          <button
            type="submit"
            className={`${s.btn} ${s.btnPrimary}`}
            disabled={state === "sending"}
          >
            {state === "sending" ? "Sending…" : section.submitLabel}
          </button>
        </div>
      </form>
    </Band>
  );
}

function Field({
  id,
  label,
  optional,
  error,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={s.field}>
      <label className={s.label} htmlFor={id}>
        {label}
        {optional ? <span className={s.optional}> — optional</span> : null}
      </label>
      {children}
      {error ? (
        <p className={s.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
