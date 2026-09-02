import type { UpcomingBookings, UpcomingBooking } from "@cc/convex-src/bookings";
import s from "./bookings.module.css";

/**
 * THE CLIENT'S DAY.
 *
 * Operate mode, and the usage scene decides everything here: a tradesman at
 * 06:40, standing beside a bakkie, one hand, in sunlight, deciding where to
 * drive. So the time is the largest thing on the row, the phone number is a
 * target you can hit without looking, and nothing animates on load — content
 * that is already there beats content that arrives beautifully.
 *
 * Every time on this screen is rendered in the CLIENT's timezone, which the
 * query hands over rather than the browser guessing. A calendar that quietly
 * renders in the phone's zone is wrong for exactly the client who travels.
 */
export function Bookings({ data }: { data: UpcomingBookings }) {
  const upcoming = data.days.reduce((total, day) => total + day.bookings.length, 0);

  return (
    <section className={s.wrap} aria-labelledby="today-heading">
      <div className={s.sectionHead}>
        <h2 className={s.sectionTitle} id="today-heading">
          Today
        </h2>
        {data.today.length > 0 ? (
          <p className={s.count}>{data.today.length} booked</p>
        ) : null}
      </div>

      {data.today.length === 0 ? (
        <p className={s.quiet}>
          Nothing booked today. Bookings appear here the moment one is taken.
        </p>
      ) : (
        <ol className={s.list}>
          {data.today.map((booking) => (
            <Row booking={booking} key={booking._id} timezone={data.timezone} today />
          ))}
        </ol>
      )}

      <div className={s.sectionHead}>
        <h2 className={s.sectionTitle} id="week-heading">
          Next 7 days
        </h2>
        {upcoming > 0 ? <p className={s.count}>{upcoming} booked</p> : null}
      </div>

      {data.days.length === 0 ? (
        <p className={s.quiet}>Nothing booked for the rest of the week.</p>
      ) : (
        data.days.map((day) => (
          <div className={s.day} key={day.dayKey}>
            <h3 className={s.dayTitle}>
              {dayLabel(day.bookings[0]!.startsAt, data.timezone, data.todayKey, day.dayKey)}
            </h3>
            <ol className={s.list}>
              {day.bookings.map((booking) => (
                <Row booking={booking} key={booking._id} timezone={data.timezone} />
              ))}
            </ol>
          </div>
        ))
      )}
    </section>
  );
}

function Row({
  booking,
  timezone,
  today = false,
}: {
  booking: UpcomingBooking;
  timezone: string;
  today?: boolean;
}) {
  const off = booking.status === "cancelled" || booking.status === "no_show";

  return (
    <li className={off ? `${s.row} ${s.rowOff}` : s.row}>
      <p className={`${s.time} tabular`}>
        <span className={s.start}>{clock(booking.startsAt, timezone)}</span>
        <span className={s.end}>&ndash;{clock(booking.endsAt, timezone)}</span>
      </p>

      <div className={s.detail}>
        <p className={s.name}>{booking.customerName}</p>
        <p className={s.service}>
          {booking.serviceName}
          {booking.locationName ? ` · ${booking.locationName}` : ""}
        </p>

        {off ? (
          <p className={s.cancelled}>
            {booking.status === "cancelled" ? "Cancelled" : "Did not arrive"}
          </p>
        ) : null}

        {booking.notes ? <p className={s.notes}>{booking.notes}</p> : null}

        {booking.customerPhone ? (
          <a className={s.call} href={`tel:${booking.customerPhone}`}>
            <span>Call</span>
            <span className="tabular">{booking.customerPhone}</span>
          </a>
        ) : (
          <p className={s.noPhone}>No phone number on file</p>
        )}

        {/*
         * Only shown for today. On a booking three days out "confirmation
         * sending" is noise; on this morning's it is the difference between a
         * customer who is expecting you and one who is not.
         *
         * The state, never the underlying error. Those sentences are written
         * for whoever runs the platform — some of them name environment
         * variables — and this screen belongs to the client.
         */}
        {today && !off ? <Confirmation state={booking.confirmation} /> : null}
      </div>
    </li>
  );
}

function Confirmation({ state }: { state: UpcomingBooking["confirmation"] }) {
  const channel = state.channel === "email" ? "by email" : state.channel === "sms" ? "by SMS" : "";

  switch (state.state) {
    case "sent":
      return <p className={s.confirmed}>Confirmed {channel}</p>;
    case "queued":
      return <p className={s.pending}>Confirmation sending</p>;
    case "not_sent":
      return <p className={s.unconfirmed}>Not confirmed — worth a call</p>;
    default:
      return <p className={s.unconfirmed}>No confirmation sent — worth a call</p>;
  }
}

/** 08:00, in the client's own timezone. */
function clock(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
}

/**
 * "Tomorrow" beats "Thursday 3 September" for the day everyone actually
 * plans around, and loses for every day after it.
 */
function dayLabel(at: number, timeZone: string, todayKey: string, dayKey: string): string {
  const tomorrow = new Date(`${todayKey}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (dayKey === tomorrow.toISOString().slice(0, 10)) return "Tomorrow";

  return new Intl.DateTimeFormat("en-ZA", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(at));
}
