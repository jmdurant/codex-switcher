import { useEffect, useRef, useState } from "react";

interface RemoveAccountModalProps {
  accountName: string;
  active: boolean;
  onRemove: () => Promise<void>;
  onClose: () => void;
}

export function RemoveAccountModal({ accountName, active, onRemove, onClose }: RemoveAccountModalProps) {
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    cancelButton.current?.focus();
    return () => { if (previousFocus instanceof HTMLElement) previousFocus.focus(); };
  }, []);

  const remove = async () => {
    if (pending.current) return;
    pending.current = true;
    setRemoving(true);
    setError(null);
    try {
      await onRemove();
      onClose();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      setError(message);
    } finally {
      pending.current = false;
      setRemoving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-account-title"
        aria-describedby="remove-account-description"
        aria-busy={removing}
        onKeyDown={event => {
          if (event.key === "Escape") {
            event.preventDefault();
            if (!pending.current) onClose();
          }
          if (event.key === "Tab") {
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
            const next = event.shiftKey ? buttons[buttons.length - 1] : buttons[0];
            const edge = event.shiftKey ? buttons[0] : buttons[buttons.length - 1];
            if (!buttons.length || document.activeElement === edge) {
              event.preventDefault();
              next?.focus();
            }
          }
        }}
        className="mx-4 w-full max-w-md rounded-2xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
      >
        <h2 id="remove-account-title" className="p-5 text-lg font-semibold text-gray-900 dark:text-gray-100">Remove account?</h2>
        <div className="space-y-3 px-5 pb-5 text-sm text-gray-600 dark:text-gray-300">
          <p id="remove-account-description">Remove <strong>{accountName}</strong> from your saved accounts?</p>
          <p>Your current Codex login and running sessions will be preserved.</p>
          {active && <p>This clears the saved account selection. Choose another saved account when you want to switch.</p>}
          {error && <p role="alert" className="whitespace-pre-wrap text-red-600 dark:text-red-300">Removal failed: {error}</p>}
        </div>
        <div className="flex justify-end gap-3 border-t border-gray-100 p-5 dark:border-gray-800">
          <button ref={cancelButton} type="button" onClick={onClose} disabled={removing} className="rounded-lg bg-gray-100 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700">Cancel</button>
          <button type="button" onClick={() => void remove()} disabled={removing} className="rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">{removing ? "Removing…" : "Remove account"}</button>
        </div>
      </div>
    </div>
  );
}
