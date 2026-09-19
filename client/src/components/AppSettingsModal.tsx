import { useEffect } from "react";
import type { MainViewMode } from "../types";
import { JEV_DISCLOSURE, type JevStatus } from "../lib/jevAssistance";

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
}: AppSettingsModalProps) {
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
