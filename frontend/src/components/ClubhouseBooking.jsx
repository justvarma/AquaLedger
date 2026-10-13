import { useEffect, useState } from "react";
import { AMENITIES } from "../lib/formulas.js";
import { monthOf } from "../lib/format.js";

const IST = 5.5 * 3600 * 1000;
const SLOT_HOURS = [6, 8, 10, 12, 14, 16, 18, 20]; // slot start times, IST

/** unix seconds for `hour`:00 IST on the given yyyy-mm-dd */
function slotStart(dateStr, hour) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor((Date.UTC(y, m - 1, d, hour) - IST) / 1000);
}

function todayIST() {
  return new Date(Date.now() + IST).toISOString().slice(0, 10);
}

/** Residents book amenities directly on-chain; each booking adds one billable slot to this month. */
export default function ClubhouseBooking({ ctx }) {
  const club = ctx.contracts.modules.CLUBHOUSE;
  const [amenity, setAmenity] = useState(0);
  const [date, setDate] = useState(todayIST());
  const [free, setFree] = useState({});
  const [hour, setHour] = useState(null);

  useEffect(() => {
    let live = true;
    setHour(null);
    Promise.all(SLOT_HOURS.map((h) => club.isSlotFree(amenity, slotStart(date, h)))).then((res) => {
      if (live) setFree(Object.fromEntries(SLOT_HOURS.map((h, i) => [h, res[i]])));
    });
    return () => {
      live = false;
    };
  }, [club, amenity, date, ctx.refreshKey]);

  const now = Date.now() / 1000;
  const book = () => {
    const start = slotStart(date, hour);
    const month = monthOf(start * 1000);
    ctx.runTx(`Book ${AMENITIES[amenity]} ${hour}:00`, () => club.book(amenity, start, month));
  };

  return (
    <div className="booking">
      <h3>Book an amenity</h3>
      <div className="row wrap">
        <label className="select">
          <span>Amenity</span>
          <select value={amenity} onChange={(e) => setAmenity(Number(e.target.value))}>
            {AMENITIES.map((a, i) => (
              <option key={a} value={i}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="select">
          <span>Date</span>
          <input type="date" value={date} min={todayIST()} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <div className="slots" role="group" aria-label="2-hour slots">
        {SLOT_HOURS.map((h) => {
          const past = slotStart(date, h) + 7200 < now;
          const taken = free[h] === false;
          return (
            <button key={h} aria-pressed={hour === h} disabled={past || taken} onClick={() => setHour(h)} title={taken ? "Already booked" : ""}>
              {String(h).padStart(2, "0")}:00–{String(h + 2).padStart(2, "0")}:00
              {taken && <span className="small"> booked</span>}
            </button>
          );
        })}
      </div>
      <button className="btn primary" disabled={hour === null} onClick={book}>
        Book slot
      </button>
    </div>
  );
}
