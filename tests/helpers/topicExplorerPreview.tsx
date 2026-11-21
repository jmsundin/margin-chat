// Renders the topic Tree explorer alone, so its node menu and the note beside can be looked at in a browser.
import { createRoot } from "react-dom/client";
import TopicExplorer from "../../client/src/components/TopicExplorer";
import "../../client/src/styles.css";

createRoot(document.getElementById("root")!).render(<div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
  <TopicExplorer workspaceKey="preview" savedTopics={{}} mapTitles={[]} documents={[{ id: "d1", title: "Deep Learning" }]} onKeep={() => ({})} onOpenDocument={() => undefined}
    onClose={() => undefined} startTitle="Deep learning" account={{ canAsk: true } as never}
    renderDocument={(id, dock) => <div style={{ padding: 8 }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}>{dock.leading}<strong>Deep Learning</strong><button type="button" onClick={dock.onClose}>×</button></div><p>Document {id} text.</p></div>} />
</div>);
