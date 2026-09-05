import { useState } from "react";
import {
  describeFileSource,
  isTauriRuntime,
  openExternalUrl,
  pickAuthJsonFile,
  type FileSource,
} from "../lib/platform";

interface AddAccountModalProps {
  isOpen: boolean;
  mode?: "add" | "relogin";
  accountName?: string;
  accountEmail?: string;
  onClose: () => void;
  onImportFile: (source: FileSource, name: string) => Promise<void>;
  onStartOAuth: (name: string) => Promise<{ auth_url: string }>;
  onCompleteOAuth: () => Promise<unknown>;
  onCancelOAuth: () => Promise<void>;
}

type Tab = "oauth" | "import";

export function AddAccountModal({
  isOpen,
  mode = "add",
  accountName,
  accountEmail,
  onClose,
  onImportFile,
  onStartOAuth,
  onCompleteOAuth,
  onCancelOAuth,
}: AddAccountModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>("oauth");
  const [name, setName] = useState("");
  const [fileSource, setFileSource] = useState<FileSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthPending, setOauthPending] = useState(false);
  const [authUrl, setAuthUrl] = useState<string>("");
  const [copied, setCopied] = useState<boolean>(false);
  const [emailCopied, setEmailCopied] = useState(false);
  const isPrimaryDisabled = loading || (activeTab === "oauth" && oauthPending);
  const tauriRuntime = isTauriRuntime();

  const resetForm = () => {
    setActiveTab("oauth");
    setName("");
    setFileSource(null);
    setError(null);
    setLoading(false);
    setOauthPending(false);
    setAuthUrl("");
    setEmailCopied(false);
  };

  const copyEmail = async () => {
    if (!accountEmail) return;
    try {
      await navigator.clipboard.writeText(accountEmail);
      setEmailCopied(true);
    } catch {
      setEmailCopied(false);
      setError("Couldn't copy the email. Copy it from the account details above.");
    }
  };

  const handleOpenLogin = async (url = authUrl, shouldCopy = true) => {
    if (shouldCopy) setError(null);
    const copying = shouldCopy && mode === "relogin" ? copyEmail() : Promise.resolve();
    try {
      if (tauriRuntime) {
        await copying;
        await openExternalUrl(url);
      } else {
        // Browser popups must open during the click's user activation.
        await openExternalUrl(url);
        await copying;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleClose = () => {
    if (oauthPending) {
      onCancelOAuth();
    }
    resetForm();
    onClose();
  };

  const handleOAuthLogin = async () => {
    try {
      setLoading(true);
      setError(null);
      // Start clipboard access during the click, before awaiting the login link.
      const copying = tauriRuntime && mode === "relogin" ? copyEmail() : Promise.resolve();
      const info = await onStartOAuth(mode === "relogin" ? (accountName ?? "") : name.trim());
      setAuthUrl(info.auth_url);
      setOauthPending(true);
      setLoading(false);

      if (tauriRuntime) {
        await copying;
        // Opening failures leave the link available and the callback listening.
        await handleOpenLogin(info.auth_url, false);
      }

      // Wait for completion
      await onCompleteOAuth();
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
      setOauthPending(false);
    }
  };

  const handleSelectFile = async () => {
    try {
      const selected = await pickAuthJsonFile();
      if (selected) setFileSource(selected);
    } catch (err) {
      console.error("Failed to open file dialog:", err);
    }
  };

  const handleImportFile = async () => {
    if (!fileSource) {
      setError("Please select an auth.json file");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await onImportFile(fileSource, name.trim());
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl w-full max-w-md mx-4 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {mode === "relogin" ? "Re-login Codex Account" : "Add Account"}
          </h2>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        {mode === "add" && <div className="flex border-b border-gray-100 dark:border-gray-800">
          {(["oauth", "import"] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => {
                if (tab === "import" && oauthPending) {
                  void onCancelOAuth().catch((err) => {
                    console.error("Failed to cancel login:", err);
                  });
                  setOauthPending(false);
                  setLoading(false);
                }
                setActiveTab(tab);
                setError(null);
              }}
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${activeTab === tab
                  ? "text-gray-900 dark:text-gray-100 border-b-2 border-gray-900 dark:border-gray-100 -mb-px"
                  : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
                }`}
            >
              {tab === "oauth" ? "ChatGPT Login" : "Import File"}
            </button>
          ))}
        </div>}

        {/* Content */}
        <div className="p-5 space-y-4">
          {/* Account name is optional; the backend derives one when blank. */}
          {mode === "add" ? <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {activeTab === "oauth" ? "Email or Account Name (optional)" : "Account Name (optional)"}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Leave blank to use email"
              className="w-full px-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-gray-400 dark:focus:border-gray-500 focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500 transition-colors"
            />
          </div> : (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
              <p className="text-xs text-gray-500 dark:text-gray-400">Replacing credentials for</p>
              <p className="mt-1 truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                {accountName}
              </p>
              {accountEmail && (
                <div className="mt-1 flex items-center gap-2">
                  <span className="break-all text-sm text-gray-700 dark:text-gray-300">{accountEmail}</span>
                  <button
                    type="button"
                    onClick={() => void copyEmail()}
                    className="shrink-0 rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600"
                  >{emailCopied ? "Copied!" : "Copy email"}</button>
                </div>
              )}
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Sign in to the same ChatGPT account. A different account will be rejected.
              </p>
            </div>
          )}

          {/* Tab-specific content */}
          {activeTab === "oauth" && (
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {oauthPending ? (
                <div className="text-center py-4">
                  <div className="animate-spin h-8 w-8 border-2 border-gray-900 dark:border-gray-100 border-t-transparent rounded-full mx-auto mb-3"></div>
                  <p className="text-gray-700 dark:text-gray-300 font-medium mb-2">Waiting for browser login...</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
                    {tauriRuntime
                      ? "Finish signing in in your browser. If it didn’t open, use Open below."
                      : "Please open the following link in your browser to proceed:"}
                  </p>
                  <div className="flex items-center gap-2 mb-2 bg-gray-50 dark:bg-gray-800 p-2 rounded-lg border border-gray-200 dark:border-gray-700">
                    <input
                      type="text"
                      readOnly
                      value={authUrl}
                      className="flex-1 bg-transparent border-none text-xs text-gray-600 dark:text-gray-300 focus:outline-none focus:ring-0 truncate"
                    />
                    <button
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(authUrl)
                          .then(() => {
                            setEmailCopied(false);
                            setCopied(true);
                            setTimeout(() => setCopied(false), 2000);
                          })
                          .catch(() => {
                            setError("Clipboard unavailable. Copy the link manually.");
                          });
                      }}
                      className={`px-3 py-1.5 border rounded text-xs font-medium transition-colors shrink-0 
                        ${copied
                          ? "bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-700 text-green-700 dark:text-green-300"
                          : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
                        }`}
                    >
                      {copied ? "Copied!" : "Copy"}
                    </button>
                    <button
                      onClick={() => void handleOpenLogin()}
                      className="px-3 py-1.5 bg-gray-900 hover:bg-gray-800 dark:bg-gray-100 dark:hover:bg-gray-200 border border-gray-900 dark:border-gray-100 rounded text-xs font-medium text-white dark:text-gray-900 transition-colors shrink-0"
                    >
                      Open
                    </button>
                  </div>
                  {mode === "relogin" && accountEmail && (
                    <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                      {emailCopied
                        ? "Email copied as a fallback if the sign-in page asks for it."
                        : "Open also copies this account’s email for you to paste into the sign-in page."}
                    </p>
                  )}
                  {!tauriRuntime && (
                    <p className="text-xs text-amber-600">
                      OAuth login must finish on the same host machine because the callback
                      redirects to `localhost`.
                    </p>
                  )}
                </div>
              ) : (
                <p>
                  {tauriRuntime
                    ? "Continue to open your browser and sign in. This dialog will close when you finish."
                    : "Generate a login link, then open it in your browser to sign in."}
                </p>
              )}
            </div>
          )}

          {mode === "add" && activeTab === "import" && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Select auth.json file
              </label>
              <div className="flex gap-2">
                <div className="flex-1 px-4 py-2.5 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-600 dark:text-gray-300 truncate">
                  {describeFileSource(fileSource)}
                </div>
                <button
                  onClick={handleSelectFile}
                  className="px-4 py-2.5 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 transition-colors whitespace-nowrap"
                >
                  Browse...
                </button>
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
                Import credentials from an existing Codex auth.json file
              </p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg text-red-600 dark:text-red-300 text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-5 border-t border-gray-100 dark:border-gray-800">
          <button
            onClick={handleClose}
            className="flex-1 px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={activeTab === "oauth" ? handleOAuthLogin : handleImportFile}
            disabled={isPrimaryDisabled}
            className="flex-1 px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-900 hover:bg-gray-800 dark:bg-gray-100 dark:hover:bg-gray-200 text-white dark:text-gray-900 transition-colors disabled:opacity-50"
          >
            {loading
              ? mode === "relogin" ? "Starting..." : "Adding..."
              : activeTab === "oauth"
                ? oauthPending ? "Waiting for sign-in…" : tauriRuntime
                  ? mode === "relogin" ? "Re-login in Browser" : "Sign in with ChatGPT"
                  : mode === "relogin" ? "Generate Re-login Link" : "Generate Login Link"
                : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
