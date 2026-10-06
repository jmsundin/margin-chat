import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderMarkdownLite } from "../src/markdown-lite";

function render(markdown: string) {
  const win = new Window({ url: "https://example.com" });
  const container = win.document.createElement("div");
  renderMarkdownLite(container as unknown as HTMLElement, markdown);
  return container;
}

describe("answer rendering", () => {
  test("never turns model output into markup", () => {
    const container = render('<img src=x onerror="alert(1)"> and <script>alert(2)</script>\n\n[bad](javascript:alert(3)) [ok](https://example.com/a)');
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    const links = [...container.querySelectorAll("a")];
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("https://example.com/a");
    expect(links[0].getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[0].getAttribute("target")).toBe("_blank");
    expect(container.textContent).toContain("[bad](javascript:alert(3))");
  });
  test("renders paragraphs, lists, emphasis, inline code and fenced code", () => {
    const container = render("# Heading\n\nA **bold** claim with `code`.\nSecond line.\n\n- one\n- two\n\n1. first\n2. second\n\n```js\nconst a = 1 < 2;\n```");
    expect(container.querySelector("p.heading")?.textContent).toBe("Heading");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("p code")?.textContent).toBe("code");
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    expect(container.querySelector("pre code")?.textContent).toBe("const a = 1 < 2;");
    expect(container.querySelector("br")).not.toBeNull();
  });
  test("tolerates text that is still streaming", () => {
    expect(render("```py\nprint(1)").querySelector("pre code")?.textContent).toBe("print(1)");
    expect(render("**unfinished and `half").textContent).toBe("**unfinished and `half");
    expect(render("").children).toHaveLength(0);
  });
});
