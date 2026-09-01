"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@cc/convex/api";
import { quickPresets } from "@/lib/callback-presets";
import s from "./tasks.module.css";

type Inbox = FunctionReturnType<typeof api.tasks.inbox>;
type Task = Inbox["overdue"][number];

/**
 * ONE INBOX.
 *
 * The thing that is currently a note beside the phone. Not a project manager
 * — a list of what will otherwise be forgotten, ordered by how late it is.
 *
 * GROUPED, NOT SORTED. A flat list by date answers "what is next"; the groups
 * answer "am I behind", which is the question that changes what happens this
 * morning. Overdue is first and counted, because if it is not zero the day
 * starts there.
 *
 * The due-date buttons are the callback presets, unchanged. It is the same
 * problem — a date agreed in half-days, typed one-handed on a phone — and
 * having solved it once, a second control that behaves differently would be
 * two things to learn.
 */
export function TaskInbox({ ventures }: { ventures: { _id: string; name: string }[] }) {
  const [ventureId, setVentureId] = useState<string>(ventures[0]?._id ?? "");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inbox = useQuery(api.tasks.inbox, ventureId ? { ventureId: ventureId as never } : {});
  const create = useMutation(api.tasks.create);
  const complete = useMutation(api.tasks.complete);

  async function add(dueAt?: number) {
    const trimmed = title.trim();
    if (trimmed.length < 2 || !ventureId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await create({ ventureId: ventureId as never, title: trimmed, dueAt });
      setTitle("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not save.");
    } finally {
      setBusy(false);
    }
  }

  if (inbox === undefined) {
    return <p className={s.muted}>Loading&hellip;</p>;
  }

  const groups: { key: string; label: string; rows: Task[] }[] = [
    { key: "overdue", label: "Overdue", rows: inbox.overdue },
    { key: "today", label: "Today", rows: inbox.today },
    { key: "upcoming", label: "Coming up", rows: inbox.upcoming },
    // Its own group, last, and never hidden. People type fake due dates
    // because systems give them nowhere else to put "someday".
    { key: "undated", label: "Someday", rows: inbox.undated },
  ];

  const empty = groups.every((group) => group.rows.length === 0);

  return (
    <>
      {ventures.length > 1 ? (
        <label className={s.filter}>
          <span className={s.filterLabel}>Venture</span>
          <select
            className={s.select}
            value={ventureId}
            onChange={(event) => setVentureId(event.target.value)}
          >
            <option value="">All ventures</option>
            {ventures.map((venture) => (
              <option key={venture._id} value={venture._id}>
                {venture.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {/*
        * The one number worth seeing before the list. If it is zero the list
        * can wait; if it is not, the morning starts there.
        */}
      {inbox.overdueCount > 0 ? (
        <p className={s.behind}>
          <span className={s.num}>{inbox.overdueCount}</span>{" "}
          {inbox.overdueCount === 1 ? "thing is" : "things are"} late.
        </p>
      ) : null}

      <div className={s.add}>
        <label className={s.addLabel} htmlFor="task-title">
          What needs doing?
        </label>
        <input
          id="task-title"
          className={s.input}
          value={title}
          placeholder="Send Upper Highway the quote"
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            // Enter files it with no date rather than nothing happening.
            if (event.key === "Enter") void add(undefined);
          }}
        />
        {title.trim().length >= 2 ? (
          <div className={s.when}>
            {quickPresets(new Date()).map((preset) => (
              <button
                key={preset.key}
                type="button"
                className={s.whenButton}
                disabled={busy || preset.at === null}
                onClick={() => preset.at !== null && void add(preset.at)}
              >
                {preset.label}
              </button>
            ))}
            <button
              type="button"
              className={s.whenButton}
              disabled={busy}
              onClick={() => void add(undefined)}
            >
              No date
            </button>
          </div>
        ) : null}
      </div>

      {error ? (
        <p className={s.error} role="alert">
          {error}
        </p>
      ) : null}

      {empty ? (
        <p className={s.muted}>Nothing outstanding.</p>
      ) : (
        groups
          .filter((group) => group.rows.length > 0)
          .map((group) => (
            <section key={group.key} className={s.group}>
              <h2 className={s.groupHead} data-late={group.key === "overdue" ? "" : undefined}>
                {group.label}
                <span className={s.count}>{group.rows.length}</span>
              </h2>
              <ul className={s.list}>
                {group.rows.map((task) => (
                  <li key={task.taskId} className={s.row}>
                    <button
                      type="button"
                      className={s.tick}
                      aria-label={`Mark "${task.title}" done`}
                      disabled={busy}
                      onClick={() => void complete({ taskId: task.taskId as never })}
                    >
                      {/* A box, not a checkmark: it is unticked until tapped. */}
                      <span className={s.box} aria-hidden="true" />
                    </button>
                    <span className={s.title}>{task.title}</span>
                    {task.dueInDays !== null ? (
                      <span className={s.due} data-late={task.overdue ? "" : undefined}>
                        {dueLabel(task.dueInDays)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))
      )}
    </>
  );
}

/**
 * Relative, because that is how lateness is felt. "4 days late" prompts a
 * different action from "due in 4 days", and a bare date makes you do the
 * arithmetic every time you read the list.
 */
function dueLabel(days: number): string {
  if (days < -1) return `${Math.abs(days)}d late`;
  if (days === -1) return "1d late";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `${days}d`;
}
