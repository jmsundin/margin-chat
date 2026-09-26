import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window();
Object.assign(globalThis, { window: browser, document: browser.document });
const { renderMarkdownToHtml, renderObsidianMarkdownToHtml } = await import("../../client/src/lib/markdown");
for (const render of [renderMarkdownToHtml, renderObsidianMarkdownToHtml]) {
  const html = render(String.raw`Inline $x^2$ and \(\frac{a}{b}\).

$$
\int_{0}^{1} x\,dx
$$

<script>alert(1)</script>`);
  browser.document.body.innerHTML = html;
  assert.equal(browser.document.querySelectorAll(".katex").length, 3);
  // happy-dom incorrectly assigns HTML's namespace to the first MathML tree;
  // DOMPurify removes that tree. The renderer unit test verifies MathML output.
  assert.ok(browser.document.querySelectorAll("math").length > 0);
  assert.equal(browser.document.querySelectorAll(".katex-display").length, 1);
  assert.equal(browser.document.querySelectorAll("script").length, 0);
  assert.match(render(String.raw`Bad $\frac{$ formula.`), /document-math-error/);
  assert.doesNotMatch(render("`$code$` and $5 or $10"), /class="katex"/);
}
console.log("LaTeX renderers passed");
await browser.happyDOM.close();
