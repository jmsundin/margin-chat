import { useState } from "react";
import { createRoot } from "react-dom/client";
import LiveDocumentEditor from "../../client/src/components/LiveDocumentEditor";
import "katex/dist/katex.min.css";
import "../../client/src/styles.css";
import "../../client/src/components/DocumentPanel.css";
import "../../client/src/components/RichDocumentEditor.css";

const now = new Date().toISOString();
const b = (id: string, content: string, extra: any = {}) => ({ id, kind: "markdown", content, createdAt: now, updatedAt: now, authorship: "user", ...extra });
const initial = [
  b("h1", "# Trip planning notes"),
  b("p1", "We want a **slow** week on the coast, with time for [[Reading list]] and ==long walks==."),
  b("h2", "## Places"),
  b("l1", "- Lisbon: tram 28, the Alfama\n- Porto: the Ribeira at sunset\n- Sintra, if the weather holds"),
  b("t1", "- [x] Book flights\n- [ ] Find a flat near the water"),
  b("q1", "> Travel slowly; the place will tell you what it is."),
  b("a1", "An AI answer: late September is quieter, still warm, and the Atlantic is at its warmest.", { authorship: "ai" }),
  b("c1", "```js\nconst budget = days * 120;\n```"),
  b("tb", "| City | Nights |\n| --- | --- |\n| Lisbon | 4 |\n| Porto | 3 |"),
  b("p2", "Inline math like $e^{i\\pi}+1=0$ renders too."),
];

function App() {
  const [blocks, setBlocks] = useState<any[]>(initial);
  return <div className="document-panel" style={{ maxWidth: 760, margin: "24px auto" }}>
    <div className="document-panel-content"><div className="panel-body document-body has-prompt-markers">
      <LiveDocumentEditor conversationId="preview" blocks={blocks} onChangeBlocks={(next) => setBlocks(next)}
        onInvokeAI={() => {}} onSelectionChange={() => {}}
        decorations={{ p1: [{ from: 10, to: 18, branchIds: ["b1"], noteIds: [] }] }}
        renderAfterBlock={(block) => block.id === "a1" ? <div className="document-prompt-marker"><button className="document-prompt-icon" type="button" aria-label="Prompt">✦</button></div> : null} />
    </div></div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<App />);
