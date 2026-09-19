import { useState } from "react";
import { AI_PROVIDERS, normalizeAISettings } from "@margin-chat/workspace-contracts";
import type { AISettings, Conversation } from "../types";

const labels = { openai: "OpenAI", gemini: "Google Gemini", huggingface: "Hugging Face", xai: "xAI" };
const scopes = { conversation: "This chat + branch", selected: "Selected material", workspace: "Search my workspace" };

export default function AIControls({ conversation, conversations, disabled, onChange }: {
  conversation: Conversation;
  conversations: Record<string, Conversation>;
  disabled?: boolean;
  onChange: (settings: AISettings) => void;
}) {
  const settings = normalizeAISettings(conversation.ai);
  const [query, setQuery] = useState("");
  const permitted = settings.allowedProviders ?? [...AI_PROVIDERS];
  const choices = Object.values(conversations).filter((item) => item.id !== conversation.id && item.title.toLowerCase().includes(query.toLowerCase()));
  return <details className="ai-controls">
    <summary tabIndex={0}>{conversation.serviceId === "backend-services" ? `Auto · ${settings.mode[0].toUpperCase()}${settings.mode.slice(1)} · ` : "AI context · "}{scopes[settings.contextScope]}</summary>
    <div className="ai-controls-body">
      {conversation.serviceId === "backend-services" ? <label>Auto preference
        <select aria-label="Auto preference" disabled={disabled} value={settings.mode} onChange={(event) => onChange({ ...settings, mode: event.target.value as AISettings["mode"] })}>
          <option value="balanced">Balanced — match effort to the task</option>
          <option value="fast">Fast — favor speed and economy</option>
          <option value="thorough">Thorough — favor deeper analysis</option>
        </select>
      </label> : null}
      <label>Context available to AI
        <select aria-label="Context available to AI" disabled={disabled} value={settings.contextScope} onChange={(event) => onChange({ ...settings, contextScope: event.target.value as AISettings["contextScope"] })}>
          <option value="conversation">This conversation, its branch context and attachments</option>
          <option value="selected">Also include selected notes and conversations</option>
          <option value="workspace">Search relevant notes and conversations in my workspace</option>
        </select>
      </label>
      {settings.contextScope === "selected" ? <div className="ai-context-picker">
        <input aria-label="Find context material" placeholder="Find a note or conversation…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <span>{settings.selectedConversationIds.length} selected</span>
        <div className="ai-context-options">{choices.slice(0, 50).map((item) => <label key={item.id}>
          <input type="checkbox" disabled={disabled} checked={settings.selectedConversationIds.includes(item.id)} onChange={(event) => onChange({ ...settings,
            selectedConversationIds: event.target.checked ? [...settings.selectedConversationIds, item.id] : settings.selectedConversationIds.filter((id) => id !== item.id),
          })} />{item.title || "Untitled"}<small>{item.kind === "note" ? "Note" : "Chat"}</small>
        </label>)}</div>
        {!choices.length ? <small>No matching material.</small> : null}
      </div> : null}
      <fieldset disabled={disabled} className="ai-provider-options"><legend>Permitted AI providers</legend>
        {AI_PROVIDERS.map((provider) => <label key={provider}><input type="checkbox" checked={permitted.includes(provider)} onChange={(event) => onChange({ ...settings,
          allowedProviders: event.target.checked ? [...permitted, provider] : permitted.filter((value) => value !== provider),
        })} />{labels[provider]}</label>)}
      </fieldset>
      {!permitted.length ? <p role="status">Choose at least one provider before sending a message.</p> : null}
      {!permitted.includes("openai") ? <p className="ai-context-help">Attachment search uses OpenAI. With OpenAI excluded, original files are saved but their contents are not indexed or searched.</p> : null}
      <p className="ai-context-help">Personal margin notes and side notes stay private. Context uses your latest local edits. Each response records the sources and model it used.</p>
    </div>
  </details>;
}
