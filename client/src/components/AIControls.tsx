import DismissibleDetails from "./DismissibleDetails";
import { useState } from "react";
import { AI_PROVIDERS, normalizeAISettings } from "@margin-chat/workspace-contracts";
import type { AISettings, Conversation } from "../types";

const labels = { openai: "OpenAI", anthropic: "Anthropic Claude", gemini: "Google Gemini", huggingface: "Hugging Face", xai: "xAI" };
const scopes = { conversation: "This chat + branch", selected: "Selected material", workspace: "Search my workspace" };
const agentScopes = { conversation: "this chat + branch", selected: "selected material", workspace: "all documents" };

export default function AIControls({ conversation, conversations, disabled, onChange }: {
  conversation: Conversation;
  conversations: Record<string, Conversation>;
  disabled?: boolean;
  onChange: (settings: AISettings) => void;
}) {
  const settings = normalizeAISettings(conversation.ai);
  const [query, setQuery] = useState("");
  const permitted = settings.allowedProviders ?? [...AI_PROVIDERS];
  const agentOn = settings.agent === true || conversation.serviceId === "openai-agent";
  const agentScope = settings.agentScope ?? "workspace";
  const choices = Object.values(conversations).filter((item) => item.id !== conversation.id && item.title.toLowerCase().includes(query.toLowerCase()));
  return <DismissibleDetails className="ai-controls">
    <summary tabIndex={0}>{conversation.serviceId === "backend-services" ? `Auto · ${settings.mode[0].toUpperCase()}${settings.mode.slice(1)} · ` : "AI context · "}{scopes[settings.contextScope]}{agentOn ? ` · Agent: ${agentScopes[agentScope]}` : ""}</summary>
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
          <option value="workspace">Search relevant documents, notes, chats and files in my workspace</option>
        </select>
      </label>
      {agentOn ? <label>Agent mode can search
        <select aria-label="What Agent mode can search" disabled={disabled} value={agentScope} onChange={(event) => onChange({ ...settings, agentScope: event.target.value as NonNullable<AISettings["agentScope"]> })}>
          <option value="workspace">All my saved documents</option>
          <option value="selected">Only the selected notes and conversations</option>
          <option value="conversation">Only this conversation and its branch</option>
        </select>
      </label> : null}
      {settings.contextScope === "selected" || (agentOn && agentScope === "selected") ? <div className="ai-context-picker">
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
      {!permitted.includes("openai") ? <p className="ai-context-help">Search by meaning uses OpenAI. With OpenAI excluded, this chat's attachments aren't searched and your vault is searched by exact words only.</p> : null}
      <p className="ai-context-help">Context uses your latest document edits, including margin documents within the selected scope. Each response records the sources and model it used.</p>
    </div>
  </DismissibleDetails>;
}
