import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BACKEND_SERVICE_OPTIONS,
  type BackendServiceModel,
  type BackendServiceOption,
  getBackendServiceModelLabel,
  getBackendServiceSelectionLabel,
} from "../lib/services";
import type { BackendServiceId } from "../types";

interface ServicePickerModalProps {
  currentModelId: string;
  currentServiceId: BackendServiceId;
  isOpen: boolean;
  onClose: () => void;
  onSelectModel: (serviceId: BackendServiceId, modelId: string) => void;
}

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      className="service-picker-search-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.9"
    >
      <circle cx="11" cy="11" r="6.75" />
      <path d="m16.25 16.25 4 4" />
    </svg>
  );
}

function ChevronDownIcon({ isExpanded }: { isExpanded: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={isExpanded ? "service-picker-chevron is-expanded" : "service-picker-chevron"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function matchesModel(
  query: string,
  service: BackendServiceOption,
  model: BackendServiceModel,
) {
  if (!query) {
    return true;
  }

  const searchableText = [
    model.badgeLabel ?? "",
    model.description,
    model.label,
    service.description,
    service.label,
    service.provider,
    ...service.keywords,
  ]
    .join(" ")
    .toLowerCase();

  return searchableText.includes(query);
}

export default function ServicePickerModal({
  currentModelId,
  currentServiceId,
  isOpen,
  onClose,
  onSelectModel,
}: ServicePickerModalProps) {
  const [query, setQuery] = useState("");
  const [expandedProviderId, setExpandedProviderId] =
    useState<BackendServiceId | null>(currentServiceId);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      return undefined;
    }

    setExpandedProviderId(currentServiceId);
    inputRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [currentServiceId, isOpen, onClose]);

  useEffect(() => {
    if (!isOpen || typeof document === "undefined") {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const normalizedQuery = query.trim().toLowerCase();
  const currentSelectionLabel = getBackendServiceSelectionLabel(
    currentServiceId,
    currentModelId,
  );
  const featuredModels: Array<{
    model: BackendServiceModel;
    service: BackendServiceOption;
  }> = [];
  const providerSections = BACKEND_SERVICE_OPTIONS.map((service) => ({
    ...service,
    visibleModels: service.models.filter((model) =>
      matchesModel(normalizedQuery, service, model),
    ),
  })).filter((service) => service.visibleModels.length > 0 || !normalizedQuery);

  for (const service of BACKEND_SERVICE_OPTIONS) {
    if (service.id === "backend-services") {
      continue;
    }

    for (const model of service.models) {
      if (!model.featured || !matchesModel(normalizedQuery, service, model)) {
        continue;
      }

      featuredModels.push({
        model,
        service,
      });
    }
  }

  const hasVisibleContent = featuredModels.length || providerSections.length;

  const modal = (
    <div
      className="service-picker-backdrop"
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
      onWheel={(event) => event.stopPropagation()}
      role="presentation"
    >
      <section
        aria-label="Choose AI model"
        aria-modal="true"
        className="service-picker-modal"
        onClick={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        role="dialog"
      >
        <label className="service-picker-search-shell">
          <SearchIcon />
          <input
            ref={inputRef}
            aria-label="Search AI models"
            className="service-picker-search-input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models or providers..."
            type="search"
            value={query}
          />
        </label>

        <div className="service-picker-context">
          <span className="service-picker-context-label">Current selection</span>
          <strong>{currentSelectionLabel}</strong>
        </div>

        <div className="service-picker-groups">
          {featuredModels.length ? (
            <section className="service-picker-section">
              <div className="service-picker-section-head">
                <div>
                  <h2>New & Popular</h2>
                  <p>Pick one of the strongest current model recommendations right away.</p>
                </div>
              </div>

              <div className="service-picker-model-list">
                {featuredModels.map(({ model, service }) => {
                  const isCurrent =
                    currentServiceId === service.id && currentModelId === model.id;

                  return (
                    <button
                      key={`${service.id}-${model.id}`}
                      className={
                        isCurrent
                          ? "service-picker-model-card is-featured is-current"
                          : "service-picker-model-card is-featured"
                      }
                      onClick={() => {
                        onSelectModel(service.id, model.id);
                        onClose();
                      }}
                      type="button"
                    >
                      <span
                        className={`service-picker-card-icon is-${service.id}`}
                        aria-hidden="true"
                      >
                        {service.iconLabel}
                      </span>

                      <span className="service-picker-model-copy">
                        <span className="service-picker-model-title-row">
                          <span className="service-picker-model-title">
                            {model.label}
                          </span>
                          <span className="service-picker-model-provider">
                            {service.provider}
                          </span>
                          {model.badgeLabel ? (
                            <span className="service-picker-model-badge">
                              {model.badgeLabel}
                            </span>
                          ) : null}
                          {isCurrent ? (
                            <span className="service-picker-provider-current">
                              Selected
                            </span>
                          ) : null}
                        </span>
                        <span className="service-picker-model-description">
                          {model.description}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}

          {providerSections.length ? (
            <section className="service-picker-section">
              <div className="service-picker-section-head">
                <div>
                  <h2>Providers & Modes</h2>
                  <p>Open a provider to reveal the best model options supported here.</p>
                </div>
              </div>

              <div className="service-picker-provider-list">
                {providerSections.map((service) => {
                  const isExpanded =
                    Boolean(normalizedQuery) || expandedProviderId === service.id;
                  const isCurrentProvider = currentServiceId === service.id;
                  const currentProviderModelLabel = isCurrentProvider
                    ? getBackendServiceModelLabel(currentServiceId, currentModelId)
                    : null;

                  return (
                    <section
                      key={service.id}
                      className={
                        isExpanded
                          ? "service-picker-provider is-expanded"
                          : "service-picker-provider"
                      }
                    >
                      <button
                        aria-expanded={isExpanded}
                        className={
                          isCurrentProvider
                            ? "service-picker-provider-button is-current"
                            : "service-picker-provider-button"
                        }
                        onClick={() =>
                          setExpandedProviderId((current) =>
                            current === service.id ? null : service.id,
                          )
                        }
                        type="button"
                      >
                        <span
                          className={`service-picker-card-icon is-${service.id}`}
                          aria-hidden="true"
                        >
                          {service.iconLabel}
                        </span>

                        <span className="service-picker-provider-copy">
                          <span className="service-picker-provider-name">
                            {service.provider}
                          </span>
                          <span className="service-picker-provider-description">
                            {service.description}
                          </span>
                        </span>

                        <span className="service-picker-provider-meta">
                          {currentProviderModelLabel ? (
                            <span className="service-picker-provider-current">
                              {currentProviderModelLabel}
                            </span>
                          ) : null}
                          <ChevronDownIcon isExpanded={isExpanded} />
                        </span>
                      </button>

                      {isExpanded ? (
                        <div className="service-picker-model-list is-provider-list">
                          {service.visibleModels.map((model) => {
                            const isCurrent =
                              currentServiceId === service.id &&
                              currentModelId === model.id;

                            return (
                              <button
                                key={model.id}
                                className={
                                  isCurrent
                                    ? "service-picker-model-card is-current"
                                    : "service-picker-model-card"
                                }
                                onClick={() => {
                                  onSelectModel(service.id, model.id);
                                  onClose();
                                }}
                                type="button"
                              >
                                <span className="service-picker-model-copy">
                                  <span className="service-picker-model-title-row">
                                    <span className="service-picker-model-title">
                                      {model.label}
                                    </span>
                                    {model.badgeLabel ? (
                                      <span className="service-picker-model-badge">
                                        {model.badgeLabel}
                                      </span>
                                    ) : null}
                                    {isCurrent ? (
                                      <span className="service-picker-provider-current">
                                        Selected
                                      </span>
                                    ) : null}
                                  </span>
                                  <span className="service-picker-model-description">
                                    {model.description}
                                  </span>
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            </section>
          ) : null}

          {!hasVisibleContent ? (
            <div className="service-picker-empty">
              <strong>No models matched.</strong>
              <p>Try GPT, Gemini, DeepSeek, Qwen, or the provider name.</p>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );

  return typeof document !== "undefined"
    ? createPortal(modal, document.body)
    : modal;
}
