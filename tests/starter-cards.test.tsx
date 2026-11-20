import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import StarterCards from "../client/src/components/StarterCards";

const noop = () => {};

test("a new vault is offered four ways to start", () => {
  const html = renderToStaticMarkup(<StarterCards onBringNotes={noop} onAddFiles={noop} onBringChats={noop} onNewDocument={noop} />);
  for (const title of ["Bring my notes", "Read something with me", "Bring my chat history", "Just write"]) expect(html).toContain(title);
  expect(html.match(/class="starter-card"/g)).toHaveLength(4);
});

test("cards the workspace can't run are left out", () => {
  const html = renderToStaticMarkup(<StarterCards onBringNotes={noop} onNewDocument={noop} />);
  expect(html.match(/class="starter-card"/g)).toHaveLength(2);
  expect(html).not.toContain('type="file"');
});
