import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

const ToastContext = createContext(() => {});

/**
 * Short confirmations disappear after a few seconds. Errors stay until they are dismissed and are
 * announced assertively, so nobody misses that something did not work.
 */
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const next = useRef(1);
  const dismiss = useCallback((id) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const toast = useCallback((message, tone = 'info') => {
    const id = next.current++;
    setItems((list) => [...list.slice(-3), { id, message, tone }]);
    if (tone !== 'error') setTimeout(() => dismiss(id), 5000);
  }, [dismiss]);
  const value = useMemo(() => toast, [toast]);
  const polite = items.filter((t) => t.tone !== 'error');
  const errors = items.filter((t) => t.tone === 'error');
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts">
        <div role="status" aria-live="polite">{polite.map((t) => <div key={t.id} className="toast">{t.message}</div>)}</div>
        <div role="alert" aria-live="assertive">
          {errors.map((t) => (
            <div key={t.id} className="toast toast-error">
              <span>{t.message}</span>
              <button type="button" className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss message">×</button>
            </div>
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
