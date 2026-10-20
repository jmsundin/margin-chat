import { useEffect, useSyncExternalStore } from "react";
import { dictationShortcutLabel, dictationSupported, readDictationButtonPreference, readHoldSpacePreference, saveDictationButtonPreference, saveHoldSpacePreference, subscribeDictationButtonPreference } from "../lib/dictation";
import { readDocumentEditorKind, saveDocumentEditorKind, subscribeDocumentEditorPreference } from "../lib/documentEditorPreference";
import type { MainViewMode } from "../types";
import { JEV_DISCLOSURE, type JevStatus } from "../lib/jevAssistance";
import { VAULT_SEARCH_DISCLOSURE, type VaultPassageIndex } from "../lib/useVaultPassageIndex";

function vaultIndexSummary(index: VaultPassageIndex) {
  const { status } = index;
  if (index.error) return `Indexing stopped: ${index.error}`;
  if (!status) return index.indexing ? "Indexing your vault…" : null;
  if (!status.available) return "Vault search isn't set up on this server.";
  const passages = `${status.passages.toLocaleString("en-US")} passage${status.passages === 1 ? "" : "s"} indexed`;
  if (!status.cloudEmbeddings) return `${passages}, searchable by exact words.`;
  const pending = status.passages - status.embedded;
  if (index.warning && pending > 0) return `${passages}. ${index.warning}`;
  if (index.indexing || pending > 0) return `${passages}; ${status.embedded.toLocaleString("en-US")} searchable by meaning so far.`;
  return `${passages}, all searchable by meaning.`;
}

type ThemeMode = "light" | "dark";

interface AppSettingsModalProps {
  isOpen: boolean;
  mainViewMode: MainViewMode;
  onClose: () => void;
  onSetMainViewMode: (mode: MainViewMode) => void;
  onSetTheme: (theme: ThemeMode) => void;
  theme: ThemeMode;
  jevEnabled?: boolean;
  jevStatus?: JevStatus;
  onSetJevEnabled?: (enabled: boolean) => void;
  /** The cloud vault's search index; absent when the workspace isn't stored in the cloud. */
  vaultIndex?: VaultPassageIndex;
}

export default function AppSettingsModal({
  isOpen,
  mainViewMode,
  onClose,
  onSetMainViewMode,
  onSetTheme,
  theme,
  jevEnabled = false,
  jevStatus = "off",
  onSetJevEnabled,
  vaultIndex,
}: AppSettingsModalProps) {
  const showDictationButton = useSyncExternalStore(subscribeDictationButtonPreference, readDictationButtonPreference, () => true);
  const holdSpaceToTalk = useSyncExternalStore(subscribeDictationButtonPreference, readHoldSpacePreference, () => true);
  const documentEditor = useSyncExternalStore(subscribeDocumentEditorPreference, readDocumentEditorKind, () => "live" as const);
  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="thread-dialog-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <section
        aria-labelledby="app-settings-title"
        aria-modal="true"
        className="thread-dialog app-settings-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="thread-dialog-head">
          <div>
            <p className="eyebrow">Settings</p>
            <h2 id="app-settings-title">App settings</h2>
          </div>
        </div>

        <div className="app-settings-body">
          <div className="app-settings-section">
            <div className="app-settings-copy">
              <span className="app-settings-label">Theme</span>
              <p className="app-settings-description">
                Choose the workspace theme, or use the quick toggle in the
                sidebar footer.
              </p>
            </div>

            <div aria-label="Theme" className="app-settings-option-group" role="group">
              <button
                aria-pressed={theme === "dark"}
                className={
                  theme === "dark"
                    ? "app-settings-option is-active"
                    : "app-settings-option"
                }
                onClick={() => onSetTheme("dark")}
                type="button"
              >
                Dark
              </button>
              <button
                aria-pressed={theme === "light"}
                className={
                  theme === "light"
                    ? "app-settings-option is-active"
                    : "app-settings-option"
                }
                onClick={() => onSetTheme("light")}
                type="button"
              >
                Light
              </button>
            </div>
          </div>

          <div className="app-settings-section">
            <div className="app-settings-copy">
              <span className="app-settings-label">Main chat view</span>
              <p className="app-settings-description">
                Pick whether the main workspace opens in focused chat panels, a
                thread gallery, or the full graph canvas.
              </p>
            </div>

            <div
              aria-label="Main chat view"
              className="app-settings-option-group"
              role="group"
            >
              <button
                aria-pressed={mainViewMode === "chat"}
                className={
                  mainViewMode === "chat"
                    ? "app-settings-option is-active"
                    : "app-settings-option"
                }
                onClick={() => onSetMainViewMode("chat")}
                type="button"
              >
                Chat
              </button>
              <button
                aria-pressed={mainViewMode === "tiles"}
                className={
                  mainViewMode === "tiles"
                    ? "app-settings-option is-active"
                    : "app-settings-option"
                }
                onClick={() => onSetMainViewMode("tiles")}
                type="button"
              >
                Tiles
              </button>
              <button
                aria-pressed={mainViewMode === "graph"}
                className={
                  mainViewMode === "graph"
                    ? "app-settings-option is-active"
                    : "app-settings-option"
                }
                onClick={() => onSetMainViewMode("graph")}
                type="button"
              >
                Graph
              </button>
            </div>
          </div>

          {onSetJevEnabled ? <div className="app-settings-section jev-settings-section">
            <div className="app-settings-copy">
              <label className="app-settings-label" htmlFor="jev-assistance">Jev assistance</label>
              <p className="app-settings-description" id="jev-assistance-disclosure">{JEV_DISCLOSURE}</p>
              <p className="app-settings-description">Improves topic categories, related items, chat context selection, and Auto routing. Saved for this account on this device.</p>
              {jevEnabled && (jevStatus === "unconfigured" || jevStatus === "unavailable") ? <p className="app-settings-description" role="status">{jevStatus === "unconfigured" ? "Jev is not configured on this server." : "Jev is temporarily unavailable."} The usual chat and categories remain available.</p> : null}
            </div>
            <input id="jev-assistance" type="checkbox" role="switch" aria-describedby="jev-assistance-disclosure" checked={jevEnabled} onChange={(event) => onSetJevEnabled(event.target.checked)} />
          </div> : null}

          <div className="app-settings-section app-settings-switch-section">
            <div className="app-settings-copy">
              <label className="app-settings-label" htmlFor="classic-document-editor">Classic document editor</label>
              <p className="app-settings-description" id="classic-document-editor-disclosure">
                Documents open in Live Preview, which shows Markdown only on the line you&apos;re editing, like Obsidian. Turn this on for the earlier editor with a grip and toolbar on each block. Saved on this device.
              </p>
            </div>
            <input id="classic-document-editor" type="checkbox" role="switch" aria-describedby="classic-document-editor-disclosure"
              checked={documentEditor === "classic"} onChange={(event) => saveDocumentEditorKind(event.target.checked ? "classic" : "live")} />
          </div>

          {dictationSupported() ? <div className="app-settings-section app-settings-switch-section">
            <div className="app-settings-copy">
              <label className="app-settings-label" htmlFor="dictation-button">Voice typing button</label>
              <p className="app-settings-description" id="dictation-button-disclosure">
                Shows a mic on the text field you&apos;re in, on phones too. Press {dictationShortcutLabel()} to start and again to stop, or hold it while you talk; Esc cancels. Recordings are sent to OpenAI to transcribe, using your OpenAI key when you&apos;ve added one, otherwise your Plus credit.
              </p>
            </div>
            <input id="dictation-button" type="checkbox" role="switch" aria-describedby="dictation-button-disclosure"
              checked={showDictationButton} onChange={(event) => saveDictationButtonPreference(event.target.checked)} />
          </div> : null}

          {dictationSupported() ? <div className="app-settings-section app-settings-switch-section">
            <div className="app-settings-copy">
              <label className="app-settings-label" htmlFor="dictation-hold-space">Hold Space to talk</label>
              <p className="app-settings-description" id="dictation-hold-space-disclosure">
                In any text field, hold Space and talk, then let go to type what you said, like Claude Code. A quick tap still types a space, and on an empty document line it still opens AI; holding there talks into the AI box. Saved on this device.
              </p>
            </div>
            <input id="dictation-hold-space" type="checkbox" role="switch" aria-describedby="dictation-hold-space-disclosure"
              checked={holdSpaceToTalk} onChange={(event) => saveHoldSpacePreference(event.target.checked)} />
          </div> : null}

          {vaultIndex ? <div className="app-settings-section app-settings-switch-section">
            <div className="app-settings-copy">
              <label className="app-settings-label" htmlFor="vault-search-meaning">Search by meaning</label>
              <p className="app-settings-description" id="vault-search-meaning-disclosure">{VAULT_SEARCH_DISCLOSURE}</p>
              {vaultIndexSummary(vaultIndex) ? <p className="app-settings-description" role="status">{vaultIndexSummary(vaultIndex)}</p> : null}
            </div>
            <input id="vault-search-meaning" type="checkbox" role="switch" aria-describedby="vault-search-meaning-disclosure"
              checked={vaultIndex.status?.cloudEmbeddings ?? true} disabled={vaultIndex.saving || vaultIndex.status?.available === false}
              onChange={(event) => void vaultIndex.setCloudEmbeddings(event.target.checked)} />
          </div> : null}
        </div>

        <div className="thread-dialog-actions">
          <button
            className="thread-dialog-button is-primary"
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </div>
      </section>
    </div>
  );
}
