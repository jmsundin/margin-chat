import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  BACKEND_SERVICE_OPTIONS,
  type BackendServiceModel,
  type BackendServiceOption,
  getBackendServiceModel,
  type RecentBackendServiceSelection,
} from "../lib/services";
import type { BackendServiceId } from "../types";
import "./ServicePickerModal.css";

interface ServicePickerModalProps {
  contextControls?: ReactNode;
  currentModelId: string;
  currentServiceId: BackendServiceId;
  isOpen: boolean;
  onClose: () => void;
  onSelectModel: (serviceId: BackendServiceId, modelId: string) => void;
  recentSelections: RecentBackendServiceSelection[];
}

type ModelChoice = { model: BackendServiceModel; service: BackendServiceOption };

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg aria-hidden="true" className={expanded ? "picker-chevron is-expanded" : "picker-chevron"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function choiceLabel({ model, service }: ModelChoice) {
  return service.id === "backend-services" ? "Auto" : model.label;
}

function matchesQuery(query: string, { model, service }: ModelChoice) {
  return [choiceLabel({ model, service }), model.label, service.label, service.provider, ...service.keywords]
    .join(" ").toLowerCase().includes(query);
}

export default function ServicePickerModal({
  contextControls,
  currentModelId,
  currentServiceId,
  isOpen,
  onClose,
  onSelectModel,
  recentSelections,
}: ServicePickerModalProps) {
  const [query, setQuery] = useState("");
  const [browseProviders, setBrowseProviders] = useState(false);
  const [expandedProviderId, setExpandedProviderId] = useState<BackendServiceId | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();
  const providersId = useId();

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    setQuery("");
    setBrowseProviders(false);
    setExpandedProviderId(null);
    inputRef.current?.focus();

    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button, input:not([type="hidden"]), select, textarea, a[href], summary, [tabindex]',
    ) ?? []).filter((element) => {
      if (element.tabIndex < 0 || element.matches(":disabled") || element.closest("[hidden], [inert]")) return false;
      for (let ancestor = element.parentElement; ancestor && ancestor !== dialogRef.current; ancestor = ancestor.parentElement) {
        if (ancestor.tagName === "FIELDSET" && ancestor.hasAttribute("disabled")) {
          const legend = ancestor.querySelector(":scope > legend");
          if (!legend?.contains(element)) return false;
        }
        if (ancestor.tagName === "DETAILS" && !ancestor.hasAttribute("open")) {
          const summary = ancestor.querySelector(":scope > summary");
          if (!summary?.contains(element)) return false;
        }
      }
      return true;
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === "Tab") {
        const items = focusable();
        const first = items[0];
        const last = items.at(-1);
        if (!first || !last) return;
        const outside = !dialogRef.current?.contains(document.activeElement);
        if (event.shiftKey && (document.activeElement === first || outside)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || outside)) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    function keepFocusInDialog(event: FocusEvent) {
      if (event.target instanceof Node && !dialogRef.current?.contains(event.target)) inputRef.current?.focus();
    }
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", keepFocusInDialog);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", keepFocusInDialog);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const allChoices = BACKEND_SERVICE_OPTIONS.flatMap((service) => service.models.map((model) => ({ service, model })));
  const currentService = BACKEND_SERVICE_OPTIONS.find((service) => service.id === currentServiceId);
  const currentModel = getBackendServiceModel(currentServiceId, currentModelId);
  const currentChoice = currentService && currentModel ? { service: currentService, model: currentModel } : undefined;
  const autoChoice = allChoices.find(({ service }) => service.id === "backend-services");
  const seenRecent = new Set<string>();
  const recentChoices = recentSelections.flatMap((selection) => {
    const key = `${selection.serviceId}:${selection.modelId}`;
    const service = BACKEND_SERVICE_OPTIONS.find((option) => option.id === selection.serviceId);
    const model = getBackendServiceModel(selection.serviceId, selection.modelId);
    if (!service || !model || seenRecent.has(key)) return [];
    seenRecent.add(key);
    return [{ service, model }];
  });
  const normalizedQuery = query.trim().toLowerCase();
  const searchResults = allChoices.filter((choice) => matchesQuery(normalizedQuery, choice));

  function modelRow(choice: ModelChoice) {
    const { model, service } = choice;
    const isAuto = service.id === "backend-services";
    const isCurrent = currentServiceId === service.id && currentModelId === model.id;
    const licenseLabel = service.id === "huggingface-api" && model.badgeLabel
      ? model.badgeLabel === "OPEN-WEIGHT" ? "Custom license" : model.badgeLabel
      : null;
    return (
      <button
        key={`${service.id}:${model.id}`}
        aria-pressed={isCurrent}
        className={isCurrent ? "picker-model-row is-current" : "picker-model-row"}
        onClick={() => { onSelectModel(service.id, model.id); onClose(); }}
        title={model.description}
        type="button"
      >
        <span className="picker-model-icon" aria-hidden="true">{isAuto ? "✦" : service.iconLabel}</span>
        <span className="picker-model-copy">
          <span className="picker-model-name">{choiceLabel(choice)}{isAuto ? <span className="picker-default-label">Default</span> : null}</span>
          <span className="picker-model-detail">{isAuto ? "Let Margin Chat choose for each reply" : service.id === "openai-agent" ? "OpenAI · can explore your workspace" : service.provider}{licenseLabel ? ` · ${licenseLabel}` : ""}</span>
        </span>
        {isCurrent ? <span className="picker-selected"><span aria-hidden="true">✓</span><span className="picker-sr-only">Selected</span></span> : null}
      </button>
    );
  }

  const modal = (
    <div className="service-picker-backdrop" onClick={(event) => { event.stopPropagation(); onClose(); }} onWheel={(event) => event.stopPropagation()} role="presentation">
      <section ref={dialogRef} aria-labelledby={titleId} aria-modal="true" className="service-picker-modal compact-model-picker" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} role="dialog">
        <header className="picker-header">
          <div><h2 id={titleId}>Choose a model</h2><p>Current: {currentChoice ? choiceLabel(currentChoice) : "Auto"}</p></div>
          <button className="picker-close" aria-label="Close model picker" onClick={onClose} type="button">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m6 6 12 12M6 18 18 6" /></svg>
          </button>
        </header>
        <label className="picker-search">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
          <input ref={inputRef} aria-label="Search AI models" onChange={(event) => setQuery(event.target.value)} placeholder="Search models or providers" type="search" value={query} />
        </label>
        <div className="picker-content">
          {normalizedQuery ? (
            <section className="picker-section" aria-label="Search results">
              <h3>Search results</h3>
              {searchResults.length ? searchResults.map(modelRow) : <p className="picker-no-results" role="status">No models found. Try another model or provider name.</p>}
            </section>
          ) : (
            <>
              {recentChoices.length ? <section className="picker-section" aria-label="Recent models"><h3>Recent</h3>{recentChoices.map(modelRow)}</section> : null}
              {autoChoice && !seenRecent.has(`${autoChoice.service.id}:${autoChoice.model.id}`) ? <div className="picker-section">{modelRow(autoChoice)}</div> : null}
              <section className="picker-browse">
                <button aria-controls={providersId} aria-expanded={browseProviders} className="picker-browse-toggle" onClick={() => setBrowseProviders((open) => !open)} type="button">
                  Browse by provider<Chevron expanded={browseProviders} />
                </button>
                {browseProviders ? <div id={providersId} className="picker-providers">
                  {BACKEND_SERVICE_OPTIONS.filter((service) => service.id !== "backend-services").map((service) => {
                    const expanded = expandedProviderId === service.id;
                    const sectionId = `${providersId}-${service.id}`;
                    return <div className="picker-provider" key={service.id}>
                      <button aria-controls={sectionId} aria-expanded={expanded} className="picker-provider-toggle" onClick={() => setExpandedProviderId(expanded ? null : service.id)} type="button">
                        <span>{service.label}</span><span className="picker-provider-count">{service.models.length}</span><Chevron expanded={expanded} />
                      </button>
                      {expanded ? <div id={sectionId} className="picker-provider-models">{service.models.map((model) => modelRow({ model, service }))}</div> : null}
                    </div>;
                  })}
                </div> : null}
              </section>
            </>
          )}
          {contextControls ? (
            <section aria-label="Context and preferences" className="picker-context-controls">
              <h3>Context &amp; preferences</h3>
              {contextControls}
            </section>
          ) : null}
        </div>
      </section>
    </div>
  );
  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
}
