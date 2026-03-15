import { useEffect, useRef, useState } from "react";
import {
  BACKEND_SERVICE_OPTIONS,
  type BackendServiceModel,
  type BackendServiceOption,
  getBackendServiceLabel,
} from "../lib/services";
import type { BackendServiceId } from "../types";

interface ServicePickerModalProps {
  currentServiceId: BackendServiceId;
  isOpen: boolean;
  onClose: () => void;
  onSelectService: (serviceId: BackendServiceId) => void;
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
  currentServiceId,
  isOpen,
  onClose,
  onSelectService,
}: ServicePickerModalProps) {
  const [query, setQuery] = useState("");
  const [expandedProviderId, setExpandedProviderId] =
    useState<BackendServiceId>("openai-api");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      return undefined;
    }

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
  }, [isOpen, onClose]);

  useEffect(() => {
    if (currentServiceId === "backend-services") {
      return;
    }

    setExpandedProviderId(currentServiceId);
  }, [currentServiceId]);

  if (!isOpen) {
    return null;
  }

  const normalizedQuery = query.trim().toLowerCase();
  const featuredModels: Array<{
    model: BackendServiceModel;
    service: BackendServiceOption;
  }> = [];
  const providerSections = BACKEND_SERVICE_OPTIONS.filter(
    (service) => service.id !== "backend-services",
  )
    .map((service) => ({
      ...service,
      visibleModels: service.models.filter((model) =>
        matchesModel(normalizedQuery, service, model),
      ),
    }))
    .filter((service) => service.visibleModels.length > 0 || !normalizedQuery);

  for (const service of BACKEND_SERVICE_OPTIONS) {
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

  return (
    <div
      className="service-picker-backdrop"
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
      role="presentation"
    >
      <section
        aria-label="Choose AI service"
        aria-modal="true"
        className="service-picker-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <label className="service-picker-search-shell">
          <SearchIcon />
          <input
            ref={inputRef}
            aria-label="Search AI services"
            className="service-picker-search-input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models or providers..."
            type="search"
            value={query}
          />
        </label>

        <div className="service-picker-context">
          <span className="service-picker-context-label">Current service</span>
          <strong>{getBackendServiceLabel(currentServiceId)}</strong>
        </div>

        <div className="service-picker-groups">
          {featuredModels.length ? (
            <section className="service-picker-section">
              <div className="service-picker-section-head">
                <div>
                  <h2>New & Popular</h2>
                  <p>Jump straight into the most-used model picks.</p>
                </div>
              </div>

              <div className="service-picker-model-list">
                {featuredModels.map(({ model, service }) => (
                  <button
                    key={`${service.id}-${model.id}`}
                    className={
                      currentServiceId === service.id
                        ? "service-picker-model-card is-featured is-current"
                        : "service-picker-model-card is-featured"
                    }
                    onClick={() => {
                      onSelectService(service.id);
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
                        {currentServiceId === service.id ? (
                          <span className="service-picker-provider-current">
                            Current
                          </span>
                        ) : null}
                      </span>
                      <span className="service-picker-model-description">
                        {model.description}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {providerSections.length ? (
            <section className="service-picker-section">
              <div className="service-picker-section-head">
                <div>
                  <h2>Providers</h2>
                  <p>Open a provider to see the strongest model choices behind it.</p>
                </div>
              </div>

              <div className="service-picker-provider-list">
                {providerSections.map((service) => {
                  const isExpanded =
                    Boolean(normalizedQuery) || expandedProviderId === service.id;
                  const isCurrent = currentServiceId === service.id;

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
                          isCurrent
                            ? "service-picker-provider-button is-current"
                            : "service-picker-provider-button"
                        }
                        onClick={() =>
                          setExpandedProviderId((current) =>
                            current === service.id ? "backend-services" : service.id,
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
                          {isCurrent ? (
                            <span className="service-picker-provider-current">
                              Current
                            </span>
                          ) : null}
                          <ChevronDownIcon isExpanded={isExpanded} />
                        </span>
                      </button>

                      {isExpanded ? (
                        <div className="service-picker-model-list is-provider-list">
                          {service.visibleModels.map((model) => (
                            <button
                              key={model.id}
                              className="service-picker-model-card"
                              onClick={() => {
                                onSelectService(service.id);
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
                                </span>
                                <span className="service-picker-model-description">
                                  {model.description}
                                </span>
                              </span>
                            </button>
                          ))}
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
              <p>Try OpenAI, Gemini, Hugging Face, or a model name like GPT or Qwen.</p>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
