import { useState } from "react";
import { formatEth, formatPaise, rupeesToWei, weiToPaise } from "../lib/format.js";

/** Rupee amount drawn like the number drums on a utility meter: rupees on dark drums, paise on brass. */
export function MeterDigits({ paise, label, tone }) {
  const p = BigInt(paise ?? 0);
  const rupees = (p / 100n).toString().padStart(4, "0");
  const ps = (p % 100n).toString().padStart(2, "0");
  return (
    <div className={`meter ${tone || ""}`} role="img" aria-label={`${label}: ${formatPaise(p)}`}>
      <span className="rupee" aria-hidden="true">₹</span>
      {[...rupees].map((d, i) => (
        <span key={`r${i}`} className="drum" aria-hidden="true">
          {d}
        </span>
      ))}
      <span className="sep" aria-hidden="true">.</span>
      {[...ps].map((d, i) => (
        <span key={`p${i}`} className="drum paise" aria-hidden="true">
          {d}
        </span>
      ))}
    </div>
  );
}

export default function MeterStrip({ ctx, summary }) {
  const { contracts, address, weiPerPaise, runTx } = ctx;
  const [amount, setAmount] = useState("");
  if (!summary) return <section className="meterstrip loading" aria-busy="true" />;

  const balancePaise = weiToPaise(summary.balanceWei, weiPerPaise);
  const owed = summary.owedPaise;
  const shortBy = owed > balancePaise ? owed - balancePaise : 0n;

  const deposit = async (e) => {
    e.preventDefault();
    const n = Number(amount);
    if (!(n > 0)) return ctx.notify("error", "Enter how many rupees to deposit.");
    const value = rupeesToWei(n, weiPerPaise);
    const ok = await runTx(`Deposit ${formatPaise(n * 100)}`, () => contracts.escrow.deposit({ value }));
    if (ok) setAmount("");
  };

  return (
    <section className="meterstrip" aria-label="Escrow account">
      <div className="reading">
        <h2>Buffer in escrow</h2>
        <MeterDigits paise={balancePaise} label="Buffer in escrow" />
        <p className="muted small">{formatEth(summary.balanceWei)} held by the escrow contract</p>
      </div>
      <div className="reading">
        <h2>Bills not yet paid</h2>
        <MeterDigits paise={owed} label="Bills not yet paid" tone={summary.pendingDebt ? "debt" : ""} />
        <p className={`status-line ${summary.pendingDebt ? "debt" : owed > 0n ? "due" : "clear"}`}>
          {summary.pendingDebt
            ? `Pending debt — last settlement fell short. It rolls into next month's bill.`
            : owed > 0n
              ? shortBy > 0n
                ? `Your buffer is ${formatPaise(shortBy)} short of what's due.`
                : `Covered by your buffer. Pay now, or the admin collects it at month end.`
              : "All bills paid."}
        </p>
      </div>
      <div className="actions">
        <form onSubmit={deposit} className="deposit">
          <label htmlFor="dep">Top up buffer (₹)</label>
          <div className="row">
            <input
              id="dep"
              inputMode="decimal"
              placeholder={shortBy > 0n ? String(Math.ceil(Number(shortBy) / 100)) : "2000"}
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            />
            <button className="btn primary" type="submit">
              Deposit
            </button>
          </div>
          {amount > 0 && <span className="muted small">= {formatEth(rupeesToWei(amount, weiPerPaise), 7)}</span>}
        </form>
        <div className="row">
          <button
            className="btn"
            disabled={owed === 0n || balancePaise === 0n}
            onClick={() => runTx("Pay dues from buffer", () => contracts.escrow.settle(address))}
          >
            Pay dues now
          </button>
          <button
            className="btn ghost"
            disabled={owed > 0n || summary.balanceWei === 0n}
            title={owed > 0n ? "Clear your dues before withdrawing" : ""}
            onClick={() => runTx("Withdraw buffer", () => contracts.escrow.withdrawExcess(summary.balanceWei))}
          >
            Withdraw buffer
          </button>
        </div>
      </div>
    </section>
  );
}
