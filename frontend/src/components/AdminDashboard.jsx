import { useEffect, useState } from "react";
import { isAddress } from "ethers";
import { api } from "../lib/api.js";
import { RATE_SETTERS, describeFormula } from "../lib/formulas.js";
import { errorText, explorerTx, formatEth, formatPaise, monthLabel, recentMonths, shortAddr, shortHash, weiToPaise } from "../lib/format.js";
import VerifyResult from "./VerifyResult.jsx";

const TABS = [
  ["overview", "Overview"],
  ["residents", "Residents"],
  ["monthend", "Month end"],
  ["integrity", "Integrity check"],
  ["rates", "Rates"],
];

export default function AdminDashboard({ ctx }) {
  const [tab, setTab] = useState("overview");
  const [month, setMonth] = useState(recentMonths()[1]); // admins mostly work on the month that just ended
  return (
    <div className="dash admin">
      <section className="month-head">
        <div>
          <h1>Society admin</h1>
          <p className="muted">Admin rights come from the ResidentRegistry contract — this wallet is an admin there.</p>
        </div>
        <label className="select">
          <span>Billing month</span>
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {recentMonths().map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
        </label>
      </section>
      <nav className="tabs" aria-label="Admin sections">
        {TABS.map(([k, label]) => (
          <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === "overview" && <Overview ctx={ctx} month={month} />}
      {tab === "residents" && <Residents ctx={ctx} />}
      {tab === "monthend" && <MonthEnd ctx={ctx} month={month} />}
      {tab === "integrity" && <Integrity ctx={ctx} month={month} />}
      {tab === "rates" && <Rates ctx={ctx} />}
    </div>
  );
}

// ------------------------------------------------------------------ overview

function Overview({ ctx, month }) {
  const { config, contracts, refreshKey, weiPerPaise } = ctx;
  const [s, setS] = useState(null);
  const [collected, setCollected] = useState(null);
  useEffect(() => {
    api.syncNow().then(() => api.summary(month)).then(setS, (e) => ctx.notify("error", e.message));
    contracts.escrow.collectedWei().then(setCollected);
  }, [month, refreshKey, contracts]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!s) return <p className="muted">Loading…</p>;
  const billed = Object.fromEntries(s.byModule.map((b) => [b.module, b]));
  const readings = Object.fromEntries(s.readings.map((r) => [r.module, r]));
  const totalBilled = s.byModule.reduce((a, b) => a + b.billed_paise, 0);
  const totalPaid = s.byModule.reduce((a, b) => a + b.paid_paise, 0);

  return (
    <>
      <section className="kpis">
        <div>
          <span className="muted">Active homes</span>
          <strong>{s.residents}</strong>
        </div>
        <div>
          <span className="muted">Billed in {monthLabel(month)}</span>
          <strong>{formatPaise(totalBilled, true)}</strong>
        </div>
        <div>
          <span className="muted">Collected so far</span>
          <strong>{formatPaise(totalPaid, true)}</strong>
        </div>
        <div>
          <span className="muted">Waiting in escrow for withdrawal</span>
          <strong>{collected === null ? "…" : formatPaise(weiToPaise(collected, weiPerPaise), true)}</strong>
        </div>
      </section>
      <section className="table-block">
        <h2>By service</h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th className="num">Readings</th>
                <th className="num">Not yet on-chain</th>
                <th className="num">Bills</th>
                <th className="num">Billed</th>
                <th className="num">Paid</th>
              </tr>
            </thead>
            <tbody>
              {config.modules.map((m) => (
                <tr key={m.key}>
                  <td>{m.label}</td>
                  <td className="num">{readings[m.key]?.readings ?? 0}</td>
                  <td className="num">{readings[m.key]?.pending ?? 0}</td>
                  <td className="num">{billed[m.key]?.bills ?? 0}</td>
                  <td className="num">{formatPaise(billed[m.key]?.billed_paise ?? 0)}</td>
                  <td className="num">{formatPaise(billed[m.key]?.paid_paise ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

// ----------------------------------------------------------------- residents

function Residents({ ctx }) {
  const { contracts, signer, runTx, refreshKey, weiPerPaise } = ctx;
  const [list, setList] = useState(null);
  const [form, setForm] = useState({ wallet: "", unit_number: "", name: "", phone: "", email: "" });
  const [slotFor, setSlotFor] = useState({});

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        await api.syncNow();
        const rows = await api.residents(signer);
        const withChain = await Promise.all(
          rows.map(async (r) => {
            const s = await contracts.escrow.accountSummary(r.wallet);
            return { ...r, balanceWei: s.balanceWei, owedPaise: s.owedPaise, debt: s.pendingDebt };
          })
        );
        setList(withChain);
      } catch (e) {
        ctx.notify("error", errorText(e));
        setList([]);
      }
    }, 0);
    return () => clearTimeout(t);
  }, [signer, contracts, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const register = async (e) => {
    e.preventDefault();
    if (!isAddress(form.wallet)) return ctx.notify("error", "That wallet address isn't valid.");
    if (!form.unit_number.trim()) return ctx.notify("error", "Enter the flat / unit number.");
    const ok = await runTx(`Register ${form.unit_number}`, () => contracts.registry.registerResident(form.wallet, form.unit_number.trim()));
    if (ok) {
      await api.saveResident(signer, { ...form, unit_number: form.unit_number.trim() }).catch((err) => ctx.notify("error", err.message));
      setForm({ wallet: "", unit_number: "", name: "", phone: "", email: "" });
    }
  };

  return (
    <>
      <section className="panel">
        <h2>Register a home</h2>
        <p className="muted">The wallet and flat number go on-chain. Name and contact details stay in the off-chain database.</p>
        <form className="grid-form" onSubmit={register}>
          <label>
            Resident wallet
            <input value={form.wallet} onChange={set("wallet")} placeholder="0x…" required />
          </label>
          <label>
            Flat / unit
            <input value={form.unit_number} onChange={set("unit_number")} placeholder="A-101" required />
          </label>
          <label>
            Name
            <input value={form.name} onChange={set("name")} />
          </label>
          <label>
            Phone
            <input value={form.phone} onChange={set("phone")} />
          </label>
          <label>
            Email
            <input type="email" value={form.email} onChange={set("email")} />
          </label>
          <button className="btn primary" type="submit">
            Register on-chain
          </button>
        </form>
      </section>

      <section className="table-block">
        <h2>Homes</h2>
        {list === null ? (
          <p className="muted">Loading…</p>
        ) : list.length === 0 ? (
          <p className="muted">No homes registered yet. Use the form above.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Unit</th>
                  <th>Resident</th>
                  <th>Wallet</th>
                  <th className="num">Buffer</th>
                  <th className="num">Owes</th>
                  <th>Parking slot</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.wallet}>
                    <td>
                      <strong>{r.unit_number || "—"}</strong>
                    </td>
                    <td>
                      {r.name || <span className="muted">no contact saved</span>}
                      {r.phone && <div className="muted small">{r.phone}</div>}
                    </td>
                    <td className="hash" title={r.wallet}>
                      {shortAddr(r.wallet)}
                    </td>
                    <td className="num">{formatPaise(weiToPaise(r.balanceWei, weiPerPaise))}</td>
                    <td className={`num ${r.debt ? "debt-text" : ""}`}>
                      {formatPaise(r.owedPaise)}
                      {r.debt && <div className="small">pending debt</div>}
                    </td>
                    <td>
                      <div className="row tight">
                        <input
                          className="slot-input"
                          aria-label={`Parking slot for ${r.unit_number}`}
                          placeholder={r.parking_slot || "none"}
                          value={slotFor[r.wallet] ?? ""}
                          onChange={(e) => setSlotFor({ ...slotFor, [r.wallet]: e.target.value })}
                        />
                        <button
                          className="btn small"
                          disabled={slotFor[r.wallet] === undefined}
                          onClick={() => runTx(`Assign slot to ${r.unit_number}`, () => contracts.modules.PARKING.assignSlot(r.wallet, slotFor[r.wallet] || ""))}
                        >
                          Save
                        </button>
                      </div>
                    </td>
                    <td>
                      <span className={`pill ${r.active ? "paid" : "pending"}`}>{r.active ? "Active" : "Inactive"}</span>{" "}
                      <button
                        className="btn small ghost"
                        onClick={() =>
                          runTx(`${r.active ? "Deactivate" : "Reactivate"} ${r.unit_number}`, () =>
                            contracts.registry.setResidentActive(r.wallet, !r.active)
                          )
                        }
                      >
                        {r.active ? "Deactivate" : "Reactivate"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// ----------------------------------------------------------------- month end

function MonthEnd({ ctx, month }) {
  const { contracts, signer, runTx, address, refreshKey, weiPerPaise, chainId } = ctx;
  const [busy, setBusy] = useState("");
  const [log, setLog] = useState([]);
  const [collected, setCollected] = useState(0n);

  useEffect(() => {
    contracts.escrow.collectedWei().then(setCollected);
  }, [contracts, refreshKey]);

  const backend = async (label, fn) => {
    setBusy(label);
    try {
      const out = await fn();
      setLog((l) => [{ label, out, at: new Date() }, ...l]);
      ctx.notify("ok", `${label}: done`);
      ctx.refresh();
    } catch (e) {
      ctx.notify("error", `${label} failed. ${e.message}`);
    } finally {
      setBusy("");
    }
  };

  const steps = [
    {
      title: "Push readings on-chain",
      body: "Sends every reading the data feed has delivered so far to the module contracts, one fingerprinted batch per home. Safe to run any time.",
      action: () => backend("Push readings", () => api.push(signer, null)),
      label: "Push readings",
    },
    {
      title: `Close ${monthLabel(month)}`,
      body: "Pushes the month's last readings, then has every module contract calculate each home's bill and post it to the escrow. A closed month can't take more readings.",
      action: () => backend(`Close ${monthLabel(month)}`, () => api.closeMonth(signer, month)),
      label: "Close month",
    },
    {
      title: "Collect bills from buffers",
      body: "The escrow takes exactly what each home owes from its buffer, oldest bill first. Homes without enough get a pending-debt flag and the rest carries into next month.",
      action: () => runTx("Settle all homes", () => contracts.escrow.settleAll()),
      label: "Settle all",
    },
    {
      title: "Withdraw collected money",
      body: `${formatPaise(weiToPaise(collected, weiPerPaise))} (${formatEth(collected, 6)}) has been collected and is waiting in the escrow. This sends it to your admin wallet.`,
      action: () => runTx("Withdraw collected", () => contracts.escrow.withdrawCollected(address, collected)),
      label: "Withdraw to my wallet",
      disabled: collected === 0n,
    },
  ];

  return (
    <>
      <ol className="steps">
        {steps.map((s) => (
          <li key={s.title}>
            <div>
              <h3>{s.title}</h3>
              <p className="muted">{s.body}</p>
            </div>
            <button className="btn primary" onClick={s.action} disabled={!!busy || s.disabled}>
              {busy === s.label ? "Working…" : s.label}
            </button>
          </li>
        ))}
      </ol>
      <p className="muted small">
        Steps 1–2 are sent by the backend's data-feed wallet; steps 3–4 are signed by you in MetaMask.
      </p>
      {log.length > 0 && (
        <section className="table-block">
          <h2>What just happened</h2>
          {log.map((l, i) => (
            <div key={i} className="logentry">
              <strong>{l.label}</strong> <span className="muted small">{l.at.toLocaleTimeString()}</span>
              <ul>
                {[...(l.out.pushed || []), ...(l.out.finalized || [])].map((p, j) => (
                  <li key={j}>
                    {p.module}: {p.skipped ? `skipped (${p.skipped})` : `${p.residents} homes${p.readings ? `, ${p.readings} readings` : ""}`}{" "}
                    {p.tx && <TxLink chainId={chainId} hash={p.tx} />}
                  </li>
                ))}
                {!(l.out.pushed?.length || l.out.finalized?.length) && <li>Nothing new to send.</li>}
              </ul>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function TxLink({ chainId, hash }) {
  const link = explorerTx(chainId, hash);
  return <span className="hash">{link ? <a href={link} target="_blank" rel="noreferrer">{shortHash(hash)}</a> : shortHash(hash)}</span>;
}

// ----------------------------------------------------------------- integrity

function Integrity({ ctx, month }) {
  const { config, signer } = ctx;
  const [residents, setResidents] = useState([]);
  const [wallet, setWallet] = useState("");
  const [mod, setMod] = useState("WATER");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.residents(signer).then((r) => {
      setResidents(r);
      if (r[0]) setWallet(r[0].wallet);
    });
  }, [signer]);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await api.verify(wallet, mod, month));
    } catch (e) {
      ctx.notify("error", e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h2>Check stored readings against the chain</h2>
      <p className="muted">
        Every batch of meter readings is hashed and the hash is written on-chain when it's pushed. This re-hashes what the database holds now. If
        anyone edited a reading afterwards, the hashes stop matching.
      </p>
      <div className="row wrap">
        <label className="select">
          <span>Home</span>
          <select value={wallet} onChange={(e) => setWallet(e.target.value)}>
            {residents.map((r) => (
              <option key={r.wallet} value={r.wallet}>
                {r.unit_number} — {shortAddr(r.wallet)}
              </option>
            ))}
          </select>
        </label>
        <label className="select">
          <span>Service</span>
          <select value={mod} onChange={(e) => setMod(e.target.value)}>
            {config.modules.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <button className="btn primary" onClick={run} disabled={!wallet || busy}>
          {busy ? "Checking…" : `Check ${monthLabel(month)}`}
        </button>
      </div>
      {result && (
        <>
          <VerifyResult result={result} />
          <p className="muted small">
            On-chain total {result.onChainUsage} (raw units) across {result.onChainBatches} batches; fingerprint {shortHash(result.onChainDataHash)}.
          </p>
        </>
      )}
    </section>
  );
}

// --------------------------------------------------------------------- rates

function Rates({ ctx }) {
  const { config, contracts, runTx, signer } = ctx;
  return (
    <section className="rates">
      <p className="muted">
        Rates are stored in each module contract. Changing one is an on-chain transaction, so residents can see exactly when a rate changed.
        Money is entered in rupees.
      </p>
      {config.modules.map((m) => (
        <RateCard key={m.key} mod={m} contract={contracts.modules[m.key]} runTx={runTx} signer={signer} notify={ctx.notify} />
      ))}
    </section>
  );
}

function RateCard({ mod, contract, runTx, signer, notify }) {
  const setter = RATE_SETTERS[mod.key];
  const initial = Object.fromEntries(
    setter.fields.map((f) => [f.key, f.paise ? String(Number(mod.rules?.[f.key] ?? 0) / 100) : String(mod.rules?.[f.key] ?? "")])
  );
  const [vals, setVals] = useState(initial);
  const save = async (e) => {
    e.preventDefault();
    const args = setter.fields.map((f) => BigInt(Math.round(Number(vals[f.key]) * (f.paise ? 100 : 1))));
    const ok = await runTx(`Update ${mod.label} rates`, () => contract[setter.fn](...args));
    if (ok) api.sync(signer).then(() => notify("ok", `${mod.label} rates saved. Reload to see them everywhere.`));
  };
  return (
    <form className="ratecard" onSubmit={save}>
      <h3>{mod.label}</h3>
      <p className="muted small">{describeFormula(mod.key, mod.rules)}</p>
      <div className="fields">
        {setter.fields.map((f) => (
          <label key={f.key}>
            {f.label}
            <span className="inputwrap">
              {f.paise && <span aria-hidden="true">₹</span>}
              <input inputMode="decimal" value={vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
            </span>
          </label>
        ))}
      </div>
      <button className="btn" type="submit">
        Save {mod.label.toLowerCase()} rates
      </button>
    </form>
  );
}
