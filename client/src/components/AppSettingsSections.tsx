import { useSyncExternalStore } from "react";
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

export type ThemeMode = "light" | "dark";

export function useVoiceTypingEnabled() {
  return useSyncExternalStore(subscribeDictationButtonPreference, readDictationButtonPreference, () => true);
}

function OptionGroup<T extends string>({ label, options, value, onChange }: {
  label: string; options: Array<[T, string]>; value: T; onChange: (value: T) => void;
}) {
  return (
    <div aria-label={label} className="app-settings-option-group" role="group">
      {options.map(([option, text]) => (
        <button aria-pressed={value === option} className={value === option ? "app-settings-option is-active" : "app-settings-option"}
          key={option} onClick={() => onChange(option)} type="button">{text}</button>
      ))}
    </div>
  );
}

/** Theme, the main view and the document editor. */
export function AppearanceSettings({ mainViewMode, onSetMainViewMode, onSetTheme, theme }: {
  mainViewMode?: MainViewMode;
  onSetMainViewMode?: (mode: MainViewMode) => void;
  onSetTheme?: (theme: ThemeMode) => void;
  theme?: ThemeMode;
}) {
  const documentEditor = useSyncExternalStore(subscribeDocumentEditorPreference, readDocumentEditorKind, () => "live" as const);
  return (
    <div className="app-settings-body">
      {theme && onSetTheme ? <div className="app-settings-section">
        <div className="app-settings-copy">
          <span className="app-settings-label">Theme</span>
          <p className="app-settings-description">Choose the workspace theme, or use the quick toggle in the sidebar footer.</p>
        </div>
        <OptionGroup label="Theme" onChange={onSetTheme} options={[["dark", "Dark"], ["light", "Light"]]} value={theme} />
      </div> : null}

      {mainViewMode && onSetMainViewMode ? <div className="app-settings-section">
        <div className="app-settings-copy">
          <span className="app-settings-label">Main view</span>
          <p className="app-settings-description">Pick whether the main workspace opens in focused chat panels, a thread gallery, or the full graph canvas.</p>
        </div>
        <OptionGroup label="Main view" onChange={onSetMainViewMode} options={[["chat", "Chat"], ["tiles", "Tiles"], ["graph", "Graph"]]} value={mainViewMode} />
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
    </div>
  );
}

/** The mic button and hold-Space dictation; empty where the browser can't record. */
export function VoiceTypingSettings() {
  const showDictationButton = useVoiceTypingEnabled();
  const holdSpaceToTalk = useSyncExternalStore(subscribeDictationButtonPreference, readHoldSpacePreference, () => true);
  if (!dictationSupported()) {
    return <p className="thread-dialog-copy">Voice typing isn&apos;t available in this browser.</p>;
  }
  return (
    <div className="app-settings-body">
      <div className="app-settings-section app-settings-switch-section">
        <div className="app-settings-copy">
          <label className="app-settings-label" htmlFor="dictation-button">Voice typing button</label>
          <p className="app-settings-description" id="dictation-button-disclosure">
            Shows a mic on the text field you&apos;re in, on phones too. Press {dictationShortcutLabel()} to start and again to stop, or hold it while you talk; Esc cancels. Recordings are sent to OpenAI to transcribe, using your OpenAI key when you&apos;ve added one, otherwise your Plus credit.
          </p>
        </div>
        <input id="dictation-button" type="checkbox" role="switch" aria-describedby="dictation-button-disclosure"
          checked={showDictationButton} onChange={(event) => saveDictationButtonPreference(event.target.checked)} />
      </div>

      <div className="app-settings-section app-settings-switch-section">
        <div className="app-settings-copy">
          <label className="app-settings-label" htmlFor="dictation-hold-space">Hold Space to talk</label>
          <p className="app-settings-description" id="dictation-hold-space-disclosure">
            In any text field, hold Space and talk, then let go to type what you said, like Claude Code. A quick tap still types a space, and on an empty document line it still opens AI; holding there talks into the AI box. Saved on this device.
          </p>
        </div>
        <input id="dictation-hold-space" type="checkbox" role="switch" aria-describedby="dictation-hold-space-disclosure"
          checked={holdSpaceToTalk} onChange={(event) => saveHoldSpacePreference(event.target.checked)} />
      </div>
    </div>
  );
}

/** Jev and search by meaning, the AI features that read your vault. */
export function AiFeatureSettings({ jevEnabled = false, jevStatus = "off", onSetJevEnabled, vaultIndex }: {
  jevEnabled?: boolean;
  jevStatus?: JevStatus;
  onSetJevEnabled?: (enabled: boolean) => void;
  /** The cloud vault's search index; absent when the workspace isn't stored in the cloud. */
  vaultIndex?: VaultPassageIndex;
}) {
  if (!onSetJevEnabled && !vaultIndex) return null;
  const summary = vaultIndex ? vaultIndexSummary(vaultIndex) : null;
  return (
    <div className="app-settings-body">
      {onSetJevEnabled ? <div className="app-settings-section jev-settings-section">
        <div className="app-settings-copy">
          <label className="app-settings-label" htmlFor="jev-assistance">Jev assistance</label>
          <p className="app-settings-description" id="jev-assistance-disclosure">{JEV_DISCLOSURE}</p>
          <p className="app-settings-description">Improves topic categories, related items, chat context selection, and Auto routing. Saved for this account on this device.</p>
          {jevEnabled && (jevStatus === "unconfigured" || jevStatus === "unavailable") ? <p className="app-settings-description" role="status">{jevStatus === "unconfigured" ? "Jev is not configured on this server." : "Jev is temporarily unavailable."} The usual chat and categories remain available.</p> : null}
        </div>
        <input id="jev-assistance" type="checkbox" role="switch" aria-describedby="jev-assistance-disclosure" checked={jevEnabled} onChange={(event) => onSetJevEnabled(event.target.checked)} />
      </div> : null}

      {vaultIndex ? <div className="app-settings-section app-settings-switch-section">
        <div className="app-settings-copy">
          <label className="app-settings-label" htmlFor="vault-search-meaning">Search by meaning</label>
          <p className="app-settings-description" id="vault-search-meaning-disclosure">{VAULT_SEARCH_DISCLOSURE}</p>
          {summary ? <p className="app-settings-description" role="status">{summary}</p> : null}
        </div>
        <input id="vault-search-meaning" type="checkbox" role="switch" aria-describedby="vault-search-meaning-disclosure"
          checked={vaultIndex.status?.cloudEmbeddings ?? true} disabled={vaultIndex.saving || vaultIndex.status?.available === false}
          onChange={(event) => void vaultIndex.setCloudEmbeddings(event.target.checked)} />
      </div> : null}
    </div>
  );
}
