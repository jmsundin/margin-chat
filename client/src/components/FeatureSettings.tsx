import { FEATURE_GROUPS, FEATURE_PRESETS, FEATURES, applyFeaturePreset, matchingPreset, setFeature, useFeatures } from "../lib/features";
import "./FeatureSettings.css";

/**
 * Settings → Features: Margin Chat starts simple, and each tool beyond the page, the map and
 * Ask AI is switched on here. Presets switch several at once; the switches stay editable after.
 */
export function FeatureSettings({ guest = false }: { guest?: boolean }) {
  const features = useFeatures();
  const preset = matchingPreset(features);
  return (
    <div className="app-settings-body feature-settings">
      <p className="feature-settings-intro">
        Margin Chat starts with your documents, the map beside them, and Ask AI. Turn on what else you want; turning something off
        only hides its buttons, and everything you made with it stays in your documents.
        {guest ? " These choices are kept in this browser." : " Your choices are saved to your account, so every device matches."}
      </p>

      <div aria-label="Presets" className="feature-settings-presets" role="group">
        {FEATURE_PRESETS.map((entry) => (
          <button aria-pressed={preset === entry.id} className={preset === entry.id ? "feature-settings-preset is-active" : "feature-settings-preset"}
            key={entry.id} onClick={() => applyFeaturePreset(entry.id)} type="button">
            <strong>{entry.name}</strong>
            <span>{entry.features.length ? entry.features.map((id) => FEATURES.find((feature) => feature.id === id)!.name).join(", ") : "Just the essentials"}</span>
          </button>
        ))}
      </div>

      {FEATURE_GROUPS.map((group) => (
        <div className="feature-settings-group" key={group} role="group" aria-labelledby={`feature-group-${group}`}>
          <h3 className="feature-settings-group-name" id={`feature-group-${group}`}>{group}</h3>
          {FEATURES.filter((feature) => feature.group === group).map((feature) => (
            <div className="app-settings-section app-settings-switch-section" key={feature.id}>
              <div className="app-settings-copy">
                <label className="app-settings-label" htmlFor={`feature-${feature.id}`}>{feature.name}</label>
                <p className="app-settings-description" id={`feature-${feature.id}-description`}>{feature.description}</p>
                <p className="feature-settings-adds">Adds: {feature.adds}</p>
              </div>
              <input id={`feature-${feature.id}`} type="checkbox" role="switch" aria-describedby={`feature-${feature.id}-description`}
                checked={features[feature.id]} onChange={(event) => setFeature(feature.id, event.target.checked)} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
