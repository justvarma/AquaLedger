import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { describeFormula } from "../lib/formulas.js";
import {
  errorText,
  explorerTx,
  formatDateTime,
  formatEth,
  formatNumber,
  formatPaise,
  monthLabel,
  recentMonths,
  shortHash,
} from "../lib/format.js";
import MeterStrip from "./MeterStrip.jsx";
import UsageChart from "./UsageChart.jsx";
import ClubhouseBooking from "./ClubhouseBooking.jsx";
import VerifyResult from "./VerifyResult.jsx";

export default function ResidentDashboard({ ctx }) {
  const { config, contracts, address, refreshKey } = ctx;
  const [month, setMonth] = useState(recentMonths()[0]);
  const [selected, setSelected] = useState("WATER");
  const [summary, setSummary] = useState(null);
  const [records, setRecords] = useState({});
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setError("");
    (async () => {
      const s = await contracts.escrow.accountSummary(address);
      const recs = {};
      await Promise.all(
        config.modules.map(async (m) => {
          const c = contracts.modules[m.key];
          const rec = await c.getRecord(address, month);
          const amount = rec.billed ? rec.billPaise : await c.calculateBill(address, rec.usage);
          recs[m.key] = { usage: rec.usage, batches: Number(rec.batches), dataHash: rec.dataHash, billed: rec.billed, amount, billId: rec.billId };
        })
      );
      if (!live) return;
      setSummary({ balanceWei: s.balanceWei, owedPaise: s.owedPaise, owedWei: s.owedWei, pendingDebt: s.pendingDebt });
      setRecords(recs);
    })().catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [contracts, address, month, refreshKey, config.modules]);

  const mod = config.modules.find((m) => m.key === selected);
  const monthTotal = Object.values(records).reduce((s, r) => s + BigInt(r.amount), 0n);
  const allBilled = Object.values(records).length > 0 && Object.values(records).every((r) => r.billed);

  return (
    <div className="dash">
      {error && <p className="notice bad">{error}</p>}
      <MeterStrip ctx={ctx} summary={summary} />

      <section className="month-head">
        <div>
          <h1>{monthLabel(month)}</h1>
          <p className="muted">
            {allBilled ? "Billed" : "Running estimate"} across all services: <strong>{formatPaise(monthTotal)}</strong>
          </p>
        </div>
        <label className="select">
          <span>Month</span>
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {recentMonths().map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
        </label>
      </section>

      <nav className="rail" aria-label="Services">
        {config.modules.map((m) => {
          const r = records[m.key];
          return (
            <button key={m.key} aria-pressed={selected === m.key} onClick={() => setSelected(m.key)}>
              <span className="name">{m.label}</span>
              <span className="amt">{r ? formatPaise(r.amount, true) : "…"}</span>
              <span className={`tag ${r?.billed ? "billed" : ""}`}>{r ? (r.billed ? "Billed" : "So far") : ""}</span>
            </button>
          );
        })}
      </nav>

      {mod && <ModuleDetail ctx={ctx} mod={mod} month={month} record={records[mod.key]} />}

      <BillsTable ctx={ctx} />
      <PaymentsTable ctx={ctx} />
    </div>
  );
}

function ModuleDetail({ ctx, mod, month, record }) {
  const { address, refreshKey, chainId } = ctx;
  const [daily, setDaily] = useState(null);
  const [verify, setVerify] = useState(null);
  const [checking, setChecking] = useState(false);
  const [slot, setSlot] = useState(null);

  useEffect(() => {
    setDaily(null);
    setVerify(null);
    api.daily(address, mod.key, month).then(setDaily, () => setDaily({ days: [], total: 0, pending: 0 }));
    if (mod.key === "PARKING") ctx.contracts.modules.PARKING.ownedSlot(address).then(setSlot);
  }, [address, mod.key, month, refreshKey, ctx.contracts]);

  const runVerify = async () => {
    setChecking(true);
    try {
      setVerify(await api.verify(address, mod.key, month));
    } catch (e) {
      ctx.notify("error", e.message);
    } finally {
      setChecking(false);
    }
  };

  const onChainUsage = record ? Number(record.usage) / mod.scale : 0;

  return (
    <section className="detail">
      <div className="chart-col">
        <h2>
          Daily {mod.label.toLowerCase()} use <span className="muted">({mod.unit})</span>
        </h2>
        {daily ? (
          <UsageChart
            days={daily.days}
            unit={mod.unit}
            month={month}
            label={mod.label}
            emptyText={mod.key === "CLUBHOUSE" ? "No front-desk bookings logged this month. Bookings you make below go straight on-chain and count in the bill." : undefined}
          />
        ) : (
          <div className="chart loading" aria-busy="true" />
        )}
        {mod.key === "CLUBHOUSE" && <ClubhouseBooking ctx={ctx} month={month} />}
        {mod.key === "PARKING" && (
          <p className="muted">{slot ? `Owned slot ${slot} — the monthly slot fee is included.` : "No owned slot assigned to your flat; only visitor hours are billed."}</p>
        )}
      </div>

      <aside className="bill-col">
        <h2>{record?.billed ? "Final bill" : "Bill so far"}</h2>
        <p className="big-amount">{record ? formatPaise(record.amount) : "…"}</p>
        <p className="formula">{describeFormula(mod.key, mod.rules)}</p>

        <dl className="facts">
          <div>
            <dt>Usage recorded on-chain</dt>
            <dd>
              {formatNumber(onChainUsage)} {mod.unit}
            </dd>
          </div>
          <div>
            <dt>Readings received</dt>
            <dd>
              {daily ? `${formatNumber(daily.total)} ${mod.unit}` : "…"}
              {daily?.pending > 0 && <span className="muted small"> ({formatNumber(daily.pending)} waiting to be pushed on-chain)</span>}
            </dd>
          </div>
          <div>
            <dt>Batches anchored</dt>
            <dd>{record?.batches ?? "…"}</dd>
          </div>
          <div>
            <dt>Data fingerprint</dt>
            <dd className="hash" title={record?.dataHash}>
              {record?.batches ? shortHash(record.dataHash) : "none yet"}
            </dd>
          </div>
        </dl>

        <button className="btn" onClick={runVerify} disabled={checking || !record?.batches}>
          {checking ? "Checking…" : "Check readings against the chain"}
        </button>
        {verify && <VerifyResult result={verify} chainId={chainId} />}
      </aside>
    </section>
  );
}

function BillsTable({ ctx }) {
  const { contracts, address, refreshKey, config, chainId } = ctx;
  const [bills, setBills] = useState(null);
  const [showZero, setShowZero] = useState(false);

  useEffect(() => {
    (async () => {
      const [chainBills, dbBills] = await Promise.all([contracts.escrow.getBillsOf(address), api.bills(address).catch(() => [])]);
      const ids = await contracts.escrow.getBillIdsOf(address);
      const txById = Object.fromEntries(dbBills.map((b) => [b.id, b.tx_hash]));
      const byHash = Object.fromEntries(config.modules.map((m) => [m.keyHash, m]));
      setBills(
        chainBills
          .map((b, i) => ({
            id: Number(ids[i]),
            module: byHash[b.moduleKey]?.label || "?",
            month: Number(b.month),
            amount: b.amountPaise,
            paid: b.paidPaise,
            tx: txById[Number(ids[i])],
          }))
          .reverse()
      );
    })().catch(() => setBills([]));
  }, [contracts, address, refreshKey, config.modules]);

  const rows = (bills || []).filter((b) => showZero || b.amount > 0n);
  return (
    <section className="table-block">
      <div className="table-head">
        <h2>Bills</h2>
        <label className="check">
          <input type="checkbox" checked={showZero} onChange={(e) => setShowZero(e.target.checked)} /> Show ₹0 bills
        </label>
      </div>
      {bills === null ? (
        <p className="muted">Loading bills from the escrow contract…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No bills yet. Bills appear here when the admin closes a month.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th>Service</th>
                <th className="num">Amount</th>
                <th className="num">Paid</th>
                <th>Status</th>
                <th>Record</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const status = b.paid >= b.amount ? "paid" : b.paid > 0n ? "partial" : "pending";
                const link = b.tx && explorerTx(chainId, b.tx);
                return (
                  <tr key={b.id}>
                    <td>{monthLabel(b.month)}</td>
                    <td>{b.module}</td>
                    <td className="num">{formatPaise(b.amount)}</td>
                    <td className="num">{formatPaise(b.paid)}</td>
                    <td>
                      <StatusPill status={status} />
                    </td>
                    <td className="hash">
                      #{b.id} {b.tx && (link ? <a href={link} target="_blank" rel="noreferrer">{shortHash(b.tx)}</a> : shortHash(b.tx))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function StatusPill({ status }) {
  const text = { paid: "Paid", partial: "Part paid", pending: "Unpaid" }[status];
  const icon = { paid: "✓", partial: "◐", pending: "○" }[status];
  return (
    <span className={`pill ${status}`}>
      <span aria-hidden="true">{icon}</span> {text}
    </span>
  );
}

function PaymentsTable({ ctx }) {
  const { address, refreshKey, chainId } = ctx;
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let live = true;
    // ask the backend indexer to pick up the latest escrow events first
    api.syncNow().then(() => api.payments(address)).then((r) => live && setRows(r), () => live && setRows([]));
    return () => {
      live = false;
    };
  }, [address, refreshKey]);
  const label = { deposit: "Deposit", settlement: "Bill payment", withdrawal: "Withdrawal" };
  return (
    <section className="table-block">
      <h2>Escrow activity</h2>
      {rows === null ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No deposits or payments yet. Top up your buffer above to get started.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th className="num">Amount</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const link = explorerTx(chainId, p.tx_hash);
                return (
                  <tr key={p.id}>
                    <td>{formatDateTime(p.ts)}</td>
                    <td>{label[p.kind]}</td>
                    <td className="num">
                      {p.amount_paise != null ? formatPaise(p.amount_paise) : formatPaise(BigInt(p.amount_wei) / ctx.weiPerPaise)}
                      <span className="muted small"> {formatEth(p.amount_wei, 7)}</span>
                    </td>
                    <td className="hash">{link ? <a href={link} target="_blank" rel="noreferrer">{shortHash(p.tx_hash)}</a> : shortHash(p.tx_hash)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
