import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import ChatHistoryImport from "../../client/src/components/ChatHistoryImport";
import { chatGPTFixture } from "./chatHistoryFixture";
import "../../client/src/styles.css";

function Fixture() {
  const [open, setOpen] = useState(true);
  const [ids, setIds] = useState<string[]>([]);
  const [last, setLast] = useState("");
  const [target, setTarget] = useState<Element | null>(null);
  useEffect(() => { setTarget(document.querySelector(".history-import-body")); }, [open]);
  // Synthetic drop exercises the real archive reader and selection UI, without account data.
  function sample() {
    const data = new DataTransfer();
    data.items.add(new File([JSON.stringify([
      chatGPTFixture("planning", "Planning our autumn garden"),
      chatGPTFixture("writing", "A story about a lighthouse"),
      chatGPTFixture("code", "Understanding async JavaScript"),
    ])], "conversations.json", { type: "application/json" }));
    document.querySelector(".history-import-drop")?.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: data }));
  }
  return <main style={{ padding: 24 }}>
    <h1>Chat history import fixture</h1><p>{last}</p>
    <button onClick={() => setOpen(true)}>Open importer</button>
    {open && <ChatHistoryImport existingIds={ids} cloudSyncEnabled={false}
      onImport={async (chats) => { const next = chats.map((c) => c.id); setIds([...ids, ...next]); return { conversationIds: next, files: { "sample.md": { content: "sample" } }, skipped: 0 }; }}
      onUndo={async (receipt) => { setIds(ids.filter((id) => !receipt.conversationIds.includes(id))); return { removed: receipt.conversationIds.length, kept: 0 }; }}
      onOpenChat={(id) => setLast(`Opened ${id}`)} onClose={() => setOpen(false)} />}
    {open && target && createPortal(<button onClick={sample}>Load sample export</button>, target)}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
