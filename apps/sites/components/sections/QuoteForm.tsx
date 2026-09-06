"use client";

import { useId, useState } from "react";
import type { Section } from "@cc/site-config";
import { joinDateRange, parseDateRange, splitDateRange } from "@cc/site-config";
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
  preview = false,
}: {
  section: QuoteSection;
  slug: string;
  onSubmit?: (
    payload: Record<string, unknown>,
  ) => Promise<{ recorded: boolean; notice: { title: string; body: string } | null }>;
  /** Variant preview: nothing is recorded, and the page must say so. */
  preview?: boolean;
}) {
  const formId = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  /*
   * What the SERVER said happened. This component does not work out whether
   * the submission reached anybody — it displays the answer it was given.
   *
   * That split is the point. A demo submission is recorded as engagement and
   * reaches nobody, and a form that answers for itself says "Thanks — that is
   * with us", which leaves a real customer who found the demo waiting in for
   * a tradesman nobody sent. Deciding here would make every template a place
   * that could get it wrong.
   */
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);

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
      const supplied = values[field.key]?.trim();

      if (field.required && !supplied) {
        // Never interpolate the label into a sentence: half of them are
        // questions, and "What are we quoting? is needed" is not English.
        next[field.key] =
          field.kind === "select"
            ? "Pick one so we can price this."
            : "We need this to price the job.";
        continue;
      }

      /*
       * A HALF-PICKED RANGE IS NOT EMPTY, so the required check above passes
       * it. Somebody who chose a departure and never chose a return has an
       * answer of `2027-07-12/`, which is truthy and unusable. The server
       * refuses it through the same parser; catching it here is what turns
       * that refusal into a message beside the field rather than a rejected
       * submission after the fact.
       */
      if (field.kind === "dateRange" && supplied && !parseDateRange(supplied)) {
        const { start, end } = splitDateRange(supplied);
        next[field.key] =
          start && end
            ? "The return date cannot be before the departure date."
            : "Pick both a departure and a return date.";
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
      const outcome = await onSubmit?.({
        slug, sectionId: section.id, name, phone, answers: values, consentAccepted: consent,
      });
      setNotice(outcome?.notice ?? null);
      setState("sent");
    } catch (error) {
      setState("idle");
      // The action already produced a message aimed at this customer. Use it,
      // and fall back only when there genuinely is not one.
      const message =
        error instanceof Error && error.message
          ? error.message
          : "That did not send. Try again, or phone us instead.";
      setErrors({ form: message });
    }
  }

  if (state === "sent") {
    /*
     * A server notice OUTRANKS the configured success message. The config
     * belongs to the site; the notice is the backend saying nothing was
     * booked, and a reassuring line from the template underneath it would
     * undo the whole point of sending one.
     */
    if (notice) {
      return (
        <Band id={section.id} tone="accent" label={section.heading}>
          <h2 className={s.narrativeHeading}>{notice.title}</h2>
          {/* alert, not status: it corrects a belief the reader already has. */}
          <p className={s.success} role="alert">
            {notice.body}
          </p>
        </Band>
      );
    }

    return (
      <Band id={section.id} tone="accent" label={section.heading}>
        <h2 className={s.narrativeHeading}>
          {preview ? "That would have sent." : "Thanks — that is with us."}
        </h2>
        <p className={s.success} role="status">
          {preview
            ? "This is a template preview, so nothing was recorded and nobody will call. On a live site this is where the client's own message appears."
            : section.successMessage}
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
              group={field.kind === "dateRange"}
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
              ) : field.kind === "dateRange" ? (
                <DateRangeControl
                  id={`${formId}-${field.key}`}
                  value={values[field.key] ?? ""}
                  invalid={Boolean(errors[field.key])}
                  onChange={(next) => {
                    setValues((v) => ({ ...v, [field.key]: next }));
                    clear(field.key);
                  }}
                />
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

/**
 * TWO NATIVE DATE INPUTS, NOT A CALENDAR WIDGET.
 *
 * `<input type="date">` opens the phone's own picker — the one the customer
 * already knows, which handles their locale and their screen reader without
 * being asked. A hand-built calendar on a 375px screen is the version that
 * looks better in a screenshot and is worse in a hand, and it would be the
 * only bespoke date UI in the codebase to keep working.
 *
 * The two halves are joined into one stored answer because a quote answer IS
 * one string. A PARTIAL range is stored and kept — somebody picks a departure
 * before they pick a return, and blanking their first choice because the
 * second is missing would be the form arguing with them mid-thought. It is
 * refused at submit, by the same parser the server uses.
 *
 * `min` on the return input is the start date, so the commonest mistake is
 * unavailable rather than merely rejected — the barrier rule, at the scale of
 * one control.
 */
function DateRangeControl({
  id,
  value,
  invalid,
  onChange,
}: {
  id: string;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const { start, end } = splitDateRange(value);

  return (
    <div className={s.dateRange}>
      <span className={s.dateLeg}>
        <label className={s.dateLabel} htmlFor={id}>
          Going out
        </label>
        <input
          id={id}
          type="date"
          className={s.control}
          value={start}
          aria-invalid={invalid}
          onChange={(e) => onChange(joinDateRange(e.target.value, end))}
        />
      </span>
      <span className={s.dateLeg}>
        <label className={s.dateLabel} htmlFor={`${id}-end`}>
          Coming back
        </label>
        <input
          id={`${id}-end`}
          type="date"
          className={s.control}
          value={end}
          min={start || undefined}
          aria-invalid={invalid}
          onChange={(e) => onChange(joinDateRange(start, e.target.value))}
        />
      </span>
    </div>
  );
}

function Field({
  id,
  label,
  optional,
  error,
  group,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  error?: string;
  /**
   * TWO CONTROLS ANSWERING ONE QUESTION.
   *
   * A `<label for>` names exactly one input, so on a date range it named the
   * departure and left the return with only its own sub-label: a screen
   * reader announced "When are you going? Going out" and then, on the next
   * control, "Coming back" — with nothing to say which question that
   * belonged to. Measured in the tree, not guessed; the first input came back
   * carrying TWO labels and the second one orphaned.
   *
   * So the question labels the GROUP and each leg keeps its own short label.
   * A span rather than a label, because a label that names nothing is the bug
   * being fixed.
   */
  group?: boolean;
  children: React.ReactNode;
}) {
  const labelId = `${id}-label`;

  return (
    <div className={s.field}>
      {group ? (
        <span className={s.label} id={labelId}>
          {label}
          {optional ? <span className={s.optional}> — optional</span> : null}
        </span>
      ) : (
        <label className={s.label} htmlFor={id}>
          {label}
          {optional ? <span className={s.optional}> — optional</span> : null}
        </label>
      )}
      {group ? (
        <div role="group" aria-labelledby={labelId}>
          {children}
        </div>
      ) : (
        children
      )}
      {error ? (
        <p className={s.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
