import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/**
 * THE CLOCK.
 *
 * Everything scheduled in this codebase is here, so "what runs on its own" is
 * one file rather than a thing you learn by finding it.
 *
 * Two jobs, and they are two rather than one because they fail differently. A
 * reminder that is never QUEUED is gone — the moment passes and no later run
 * can recover it. A message that is never SENT is still a row, visible in the
 * outbox, recoverable the next time the drain runs. Sweeping and sending on
 * separate schedules means a provider outage cannot stop reminders from being
 * created, which is the half that has to keep working.
 */

const crons = cronJobs();

/**
 * THE DRAIN. Two minutes is the resolution of every message this system sends:
 * a confirmation queued the instant a booking is taken goes out within two
 * minutes of it, which reads as immediate to the person who just booked.
 *
 * Cheap to run: an indexed range read that finds nothing costs one query. It
 * is not cheap enough to run every ten seconds, and nothing here needs that —
 * the reminders are hours-granular and the confirmation is the only message
 * anyone is actually waiting on.
 */
crons.interval("drain the outbox", { minutes: 2 }, internal.outbox.drain, {});

/**
 * THE REMINDER SWEEPS.
 *
 * `windowMs` is the cron interval, so consecutive runs cover the timeline with
 * no gap. The sweep widens that by an hour of lookback on its own, so a run
 * that fails or a deployment that eats one still leaves the reminder to be
 * found by the next — and finding it twice costs nothing, because the
 * idempotency key refuses the second.
 *
 * FIFTEEN MINUTES, not one. A "tomorrow" reminder is not improved by being
 * fifteen minutes more precise, and the sweep reads a global index across
 * every client, which is the one query here whose cost grows with the
 * business. The 1-hour reminder is the tighter of the two and is still only
 * ever a quarter of an hour early, against a window a person reads as "about
 * an hour".
 */
const SWEEP_MINUTES = 15;
const SWEEP_WINDOW_MS = SWEEP_MINUTES * 60 * 1000;

crons.interval(
  "queue 24-hour booking reminders",
  { minutes: SWEEP_MINUTES },
  internal.outbox.queueDueReminders,
  { hoursBefore: 24, windowMs: SWEEP_WINDOW_MS },
);

crons.interval(
  "queue 1-hour booking reminders",
  { minutes: SWEEP_MINUTES },
  internal.outbox.queueDueReminders,
  { hoursBefore: 1, windowMs: SWEEP_WINDOW_MS },
);

export default crons;
