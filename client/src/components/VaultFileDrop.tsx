import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { useMarkdownVault } from "../lib/useMarkdownVault";
import { carriesFiles, describeDroppedFolders, droppedFiles, dropsIntoDocument, handlesOwnFileDrop } from "../lib/fileDrop";
import NotificationToast from "./NotificationToast";
import "./VaultFileDrop.css";

type Vault = Pick<ReturnType<typeof useMarkdownVault>, "uploadFiles">;

/**
 * Drop files anywhere on the app to add them to the vault, the same way
 * Upload files does. Dialogs and drop boxes with their own meaning, and
 * pictures dropped into a document, keep theirs.
 */
export default function VaultFileDrop({ vault }: { vault: Vault }) {
  const [over, setOver] = useState(false);
  const [notice, setNotice] = useState<{ message: string; kind: "info" | "success" | "error" } | null>(null);
  const vaultRef = useRef(vault);
  vaultRef.current = vault;

  useEffect(() => {
    let hide = 0;
    // A drag that leaves the window or is cancelled sends nothing more, and
    // dragover repeats while the pointer is still, so silence means it ended.
    const show = (value: boolean) => {
      window.clearTimeout(hide);
      setOver(value);
      if (value) hide = window.setTimeout(() => setOver(false), 300);
    };
    const dragover = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      if (handlesOwnFileDrop(event.target)) { show(false); return; }
      // Without this the browser would open the file in place of the app.
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
      const types = Array.from(event.dataTransfer!.items ?? []).filter((item) => item.kind === "file").map((item) => item.type);
      show(!dropsIntoDocument(event.target, types));
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      show(false);
      if (event.defaultPrevented || handlesOwnFileDrop(event.target)) return;
      event.preventDefault();
      const { files, folders } = droppedFiles(event.dataTransfer!);
      const folderNote = describeDroppedFolders(folders);
      if (!files.length) {
        if (folderNote) setNotice({ message: folderNote, kind: "error" });
        return;
      }
      setNotice({ message: files.length === 1 ? `Adding “${files[0]!.name}”…` : `Adding ${files.length} files…`, kind: "info" });
      vaultRef.current.uploadFiles(files).then(({ added, summary }) => {
        setNotice({ message: [summary, folderNote].filter(Boolean).join(" ") || "Nothing was added.", kind: added.length ? "success" : "error" });
      }, (failure: unknown) => {
        setNotice({ message: failure instanceof Error ? failure.message : "Those files couldn’t be added. Try again.", kind: "error" });
      });
    };
    window.addEventListener("dragover", dragover);
    window.addEventListener("drop", drop);
    return () => {
      window.clearTimeout(hide);
      window.removeEventListener("dragover", dragover);
      window.removeEventListener("drop", drop);
    };
  }, []);

  return <>
    {over ? createPortal(<div className="vault-file-drop" aria-hidden="true">
      <div className="vault-file-drop-card">
        <strong>Drop to add to your vault</strong>
        <span>Notes, text, PDFs, images or a zipped vault folder</span>
      </div>
    </div>, document.body) : null}
    <NotificationToast message={notice?.message ?? null} kind={notice?.kind} duration={notice?.kind === "info" ? 120000 : 10000}
      onDismiss={() => setNotice(null)} />
  </>;
}
