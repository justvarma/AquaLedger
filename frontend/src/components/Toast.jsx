import { useEffect } from "react";
import { shortHash } from "../lib/format.js";

export default function Toast({ toast, onClose, explorer }) {
  useEffect(() => {
    if (toast?.kind === "ok") {
      const t = setTimeout(onClose, 6000);
      return () => clearTimeout(t);
    }
  }, [toast, onClose]);
  if (!toast) return null;
  const link = toast.hash && explorer(toast.hash);
  return (
    <div className={`toast ${toast.kind}`} role="status" aria-live="polite">
      <span className="dot" aria-hidden="true" />
      <div>
        <div>{toast.text}</div>
        {toast.hash && (
          <div className="muted small">
            tx {link ? <a href={link} target="_blank" rel="noreferrer">{shortHash(toast.hash)}</a> : shortHash(toast.hash)}
          </div>
        )}
      </div>
      {toast.kind !== "pending" && (
        <button className="close" onClick={onClose} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}
