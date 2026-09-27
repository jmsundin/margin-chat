import { Table, TableView } from "@tiptap/extension-table";

/** Controls live outside the table content so they can never enter Markdown. */
export const DocumentTable = Table.extend({
  addNodeView() {
    return ({ node, view, HTMLAttributes, editor }) => {
      const tableView = new TableView(node, this.options.cellMinWidth, view, HTMLAttributes);
      tableView.dom.classList.add("document-table");
      const controls = document.createElement("div");
      controls.className = "document-table-controls";
      controls.contentEditable = "false";
      function addControl(kind: "row" | "column") {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "+";
        button.className = `document-table-add-${kind}`;
        button.setAttribute("aria-label", `Add ${kind} to table`);
        button.title = `Add ${kind}`;
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", (event) => {
          event.preventDefault(); event.stopPropagation();
          if (!editor.isEditable) return;
          const rows = tableView.table.rows;
          const row = kind === "row" ? rows[rows.length - 1] : rows[0];
          const cell = row?.cells[row.cells.length - 1];
          if (!cell) return;
          const position = view.posAtDOM(cell, 0) + 1;
          const chain = editor.chain().focus().setTextSelection(position);
          if (kind === "row") chain.addRowAfter().run();
          else chain.addColumnAfter().run();
        });
        controls.append(button);
      }
      addControl("row"); addControl("column");
      tableView.dom.append(controls);
      return {
        dom: tableView.dom, contentDOM: tableView.contentDOM,
        update: (next) => tableView.update(next),
        ignoreMutation: (mutation) => tableView.ignoreMutation(mutation),
        stopEvent: (event) => event.target instanceof Node && controls.contains(event.target),
      };
    };
  },
});
