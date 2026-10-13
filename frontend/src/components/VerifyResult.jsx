import { shortHash } from "../lib/format.js";

/** Shows the outcome of GET /api/verify: are the stored readings still the ones fingerprinted on-chain? */
export default function VerifyResult({ result }) {
  const r = result;
  return (
    <div className={`verify ${r.ok ? "ok" : "bad"}`} role="status">
      <p className="verdict">
        <span aria-hidden="true">{r.ok ? "✓" : "✗"}</span>{" "}
        {r.ok
          ? r.offChainBatches === 1
            ? "The stored reading batch matches its on-chain fingerprint."
            : `All ${r.offChainBatches} reading batches match their on-chain fingerprints.`
          : r.tamperedBatches
            ? `${r.tamperedBatches} of ${r.offChainBatches} batches were changed after they were recorded on-chain.`
            : "The on-chain hash chain doesn't add up."}
      </p>
      {r.batches?.length > 0 && (
        <table className="compact">
          <thead>
            <tr>
              <th>Batch</th>
              <th className="num">Readings</th>
              <th>Hash of stored readings</th>
              <th>On-chain</th>
            </tr>
          </thead>
          <tbody>
            {r.batches.map((b) => (
              <tr key={b.batchId}>
                <td>#{b.batchId}</td>
                <td className="num">{b.readings}</td>
                <td className="hash" title={b.recomputedHash}>
                  {shortHash(b.recomputedHash)}
                </td>
                <td>{b.anchoredOnChain ? "matches" : "no match"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
