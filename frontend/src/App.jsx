import { useCallback, useEffect, useMemo, useState } from "react";
import { api, API_URL } from "./lib/api.js";
import { connectWallet, hasMetaMask, makeContracts, networkName, switchNetwork } from "./lib/chain.js";
import { errorText, shortAddr, explorerTx } from "./lib/format.js";
import ResidentDashboard from "./components/ResidentDashboard.jsx";
import AdminDashboard from "./components/AdminDashboard.jsx";
import Toast from "./components/Toast.jsx";

export default function App() {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState("");
  const [wallet, setWallet] = useState(null); // { provider, signer, address, chainId }
  const [role, setRole] = useState(null); // { isAdmin, isResident, unit, active }
  const [view, setView] = useState("resident");
  const [toast, setToast] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [connecting, setConnecting] = useState(false);

  const loadConfig = useCallback(() => {
    setConfigError("");
    api.config().then(setConfig, (e) => setConfigError(e.message));
  }, []);
  useEffect(loadConfig, [loadConfig]);

  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      setWallet(await connectWallet());
    } catch (e) {
      setToast({ kind: "error", text: errorText(e) });
    } finally {
      setConnecting(false);
    }
  }, []);

  // Re-connect silently if MetaMask already authorised this site; follow account / network switches.
  useEffect(() => {
    if (!hasMetaMask()) return;
    window.ethereum.request({ method: "eth_accounts" }).then((accts) => accts.length && connect());
    const onChange = () => connect();
    window.ethereum.on?.("accountsChanged", onChange);
    window.ethereum.on?.("chainChanged", onChange);
    return () => {
      window.ethereum.removeListener?.("accountsChanged", onChange);
      window.ethereum.removeListener?.("chainChanged", onChange);
    };
  }, [connect]);

  const wrongNetwork = wallet && config && wallet.chainId !== config.chainId;
  const contracts = useMemo(
    () => (wallet && config && !wrongNetwork ? makeContracts(config.deployment, wallet.signer) : null),
    [wallet, config, wrongNetwork]
  );

  useEffect(() => {
    setRole(null);
    if (!contracts) return;
    (async () => {
      const [isAdmin, r] = await Promise.all([contracts.registry.isAdmin(wallet.address), contracts.registry.residents(wallet.address)]);
      const isResident = r.registeredAt > 0n;
      setRole({ isAdmin, isResident, unit: r.unitNumber, active: r.active });
      setView(isResident ? "resident" : isAdmin ? "admin" : "resident");
    })().catch((e) => setToast({ kind: "error", text: errorText(e) }));
  }, [contracts, wallet]);

  /** Every on-chain write goes through here so the person always sees what is happening. */
  const runTx = useCallback(
    async (label, makeTx) => {
      try {
        setToast({ kind: "pending", text: `${label}: confirm in MetaMask` });
        const tx = await makeTx();
        setToast({ kind: "pending", text: `${label}: waiting for the block…`, hash: tx.hash });
        const receipt = await tx.wait();
        setToast({ kind: "ok", text: `${label}: done`, hash: receipt.hash });
        setRefreshKey((k) => k + 1);
        return receipt;
      } catch (e) {
        setToast({ kind: "error", text: `${label} failed. ${errorText(e)}` });
        return null;
      }
    },
    []
  );

  const notify = useCallback((kind, text) => setToast({ kind, text }), []);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const ctx = contracts &&
    role && {
      config,
      contracts,
      address: wallet.address,
      signer: wallet.signer,
      chainId: wallet.chainId,
      weiPerPaise: BigInt(config.weiPerPaise),
      role,
      runTx,
      notify,
      refresh,
      refreshKey,
    };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <path d="M16 3C11 11 7 15.5 7 20a9 9 0 0 0 18 0c0-4.5-4-9-9-17z" />
          </svg>
          <span>AquaLedger</span>
        </div>
        {role?.isAdmin && role?.isResident && (
          <nav className="viewswitch" aria-label="Dashboard">
            <button aria-pressed={view === "resident"} onClick={() => setView("resident")}>
              My home
            </button>
            <button aria-pressed={view === "admin"} onClick={() => setView("admin")}>
              Society admin
            </button>
          </nav>
        )}
        <div className="wallet">
          {config && (
            <span className={`net ${wrongNetwork ? "bad" : ""}`}>{networkName(wallet?.chainId ?? config.chainId)}</span>
          )}
          {wallet ? (
            <span className="addr" title={wallet.address}>
              {role?.unit ? <strong>{role.unit}</strong> : null}
              {shortAddr(wallet.address)}
            </span>
          ) : (
            <button className="btn primary" onClick={connect} disabled={connecting || !hasMetaMask()}>
              {connecting ? "Connecting…" : "Connect MetaMask"}
            </button>
          )}
        </div>
      </header>

      <main>
        {configError && (
          <section className="notice bad">
            <h2>Backend not reachable</h2>
            <p>{configError}</p>
            <p className="muted">Expected it at {API_URL}. Change VITE_API_URL in frontend/.env if it runs elsewhere.</p>
            <button className="btn" onClick={loadConfig}>
              Try again
            </button>
          </section>
        )}

        {!configError && !wallet && <Welcome canConnect={hasMetaMask()} onConnect={connect} connecting={connecting} />}

        {wrongNetwork && (
          <section className="notice">
            <h2>Switch to {networkName(config.chainId)}</h2>
            <p>The AquaLedger contracts live on {networkName(config.chainId)}, but MetaMask is on {networkName(wallet.chainId)}.</p>
            <button className="btn primary" onClick={() => switchNetwork(config.chainId).catch((e) => notify("error", errorText(e)))}>
              Switch network
            </button>
          </section>
        )}

        {ctx && !role.isAdmin && !role.isResident && (
          <section className="notice">
            <h2>This wallet isn't registered yet</h2>
            <p>
              Ask your society admin to register <code>{wallet.address}</code> against your flat. Once they do, this page shows your usage,
              bills and escrow balance.
            </p>
          </section>
        )}

        {ctx && view === "resident" && role.isResident && <ResidentDashboard ctx={ctx} />}
        {ctx && (view === "admin" || !role.isResident) && role.isAdmin && <AdminDashboard ctx={ctx} />}
      </main>

      <Toast toast={toast} onClose={() => setToast(null)} explorer={(h) => explorerTx(wallet?.chainId, h)} />
    </div>
  );
}

function Welcome({ canConnect, onConnect, connecting }) {
  return (
    <section className="welcome">
      <h1>Every litre, unit and rupee, on the record.</h1>
      <p>
        AquaLedger keeps your society's water, power, gas, EV charging, parking, clubhouse, waste and security bills on a public blockchain.
        Meter readings are fingerprinted on-chain, bills are calculated by smart contracts, and your monthly buffer sits in an escrow
        that only releases what you were actually billed.
      </p>
      {canConnect ? (
        <button className="btn primary large" onClick={onConnect} disabled={connecting}>
          {connecting ? "Connecting…" : "Connect MetaMask to see your home"}
        </button>
      ) : (
        <p className="notice bad">
          MetaMask isn't installed in this browser. Install it from <a href="https://metamask.io">metamask.io</a>, then reload.
        </p>
      )}
    </section>
  );
}
