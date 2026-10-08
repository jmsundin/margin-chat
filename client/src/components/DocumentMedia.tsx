import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  addTimestamp, embedMarkdownForUrl, formatTimestamp, isMediaFile, isPlayable, parseTimestamp,
  type MediaBlock, type MediaEmbed,
} from "../lib/documentMedia";
import { useVaultMedia } from "../lib/vaultMedia";
import "./DocumentMedia.css";

type Player = { seek(seconds: number): void; currentTime(): number | null };

const YOUTUBE_ORIGIN = "https://www.youtube-nocookie.com";
const VIMEO_ORIGIN = "https://player.vimeo.com";

/** Load a vault file as an object URL for as long as the embed shows it. */
function useVaultObjectUrl(embed: MediaEmbed) {
  const media = useVaultMedia();
  const [state, setState] = useState<{ url?: string; status: "loading" | "ready" | "missing" | "error"; message?: string }>({ status: "loading" });
  const target = embed.source === "vault" ? embed.target : null;
  useEffect(() => {
    if (!target) return;
    if (!media) { setState({ status: "missing" }); return; }
    let url: string | undefined;
    let cancelled = false;
    setState({ status: "loading" });
    media.read(target).then((file) => {
      if (cancelled) return;
      if (!file) { setState({ status: "missing" }); return; }
      url = URL.createObjectURL(file.blob);
      setState({ status: "ready", url });
    }, (error: unknown) => {
      if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : "This file could not be opened." });
    });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [media, target]);
  return target ? state : { status: "ready" as const, url: embed.target };
}

function mediaSize(embed: MediaEmbed) {
  return { ...(embed.width ? { width: embed.width } : {}), ...(embed.height ? { height: embed.height } : {}) };
}

function FileMedia({ embed, playerRef }: { embed: MediaEmbed; playerRef: { current: Player | null } }) {
  const file = useVaultObjectUrl(embed);
  const element = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const pendingSeek = useRef<number | null>(null);
  useEffect(() => {
    playerRef.current = {
      seek(seconds) {
        const media = element.current;
        if (!media) { pendingSeek.current = seconds; return; }
        media.currentTime = seconds;
        void media.play().catch(() => undefined);
      },
      currentTime: () => element.current?.currentTime ?? null,
    };
    return () => { playerRef.current = null; };
  }, [playerRef]);
  if (file.status === "loading") return <p className="document-media-status" role="status">Loading {embed.target}…</p>;
  if (file.status === "missing") return <p className="document-media-status">“{embed.target}” isn’t in your vault yet.</p>;
  if (file.status === "error") return <p className="document-media-status" role="alert">{file.message}</p>;
  // A media fragment starts playback where the embed says, as in Obsidian.
  const src = embed.startSeconds !== undefined ? `${file.url}#t=${embed.startSeconds}` : file.url;
  const onLoaded = () => {
    if (pendingSeek.current === null || !element.current) return;
    element.current.currentTime = pendingSeek.current;
    pendingSeek.current = null;
  };
  if (embed.kind === "image") return <img src={file.url} alt={embed.alt || embed.target.split("/").at(-1)} loading="lazy" style={mediaSize(embed)} />;
  if (embed.kind === "audio") return <audio ref={element} src={src} controls preload="metadata" onLoadedMetadata={onLoaded} aria-label={embed.alt || embed.target} />;
  return <video ref={element} src={src} controls playsInline preload="metadata" onLoadedMetadata={onLoaded} style={mediaSize(embed)} aria-label={embed.alt || embed.target} />;
}

/** YouTube and Vimeo players report their time and seek through postMessage. */
function EmbeddedPlayer({ embed, playerRef }: { embed: MediaEmbed; playerRef: { current: Player | null } }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const time = useRef<number | null>(null);
  const youtube = embed.kind === "youtube";
  const origin = youtube ? YOUTUBE_ORIGIN : VIMEO_ORIGIN;
  const start = embed.startSeconds !== undefined ? Math.floor(embed.startSeconds) : undefined;
  const src = youtube
    ? `${YOUTUBE_ORIGIN}/embed/${encodeURIComponent(embed.videoId!)}?enablejsapi=1&playsinline=1&rel=0&origin=${encodeURIComponent(window.location.origin)}${start !== undefined ? `&start=${start}` : ""}`
    : `${VIMEO_ORIGIN}/video/${encodeURIComponent(embed.videoId!)}?api=1${start !== undefined ? `#t=${start}s` : ""}`;
  useEffect(() => {
    const post = (message: unknown) => frame.current?.contentWindow?.postMessage(youtube ? JSON.stringify(message) : message, origin);
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      let data = event.data;
      if (typeof data === "string") { try { data = JSON.parse(data); } catch { return; } }
      const seconds = youtube ? data?.info?.currentTime : data?.event === "timeupdate" ? data?.data?.seconds : undefined;
      if (typeof seconds === "number" && Number.isFinite(seconds)) time.current = seconds;
    };
    window.addEventListener("message", receive);
    playerRef.current = {
      seek(seconds) {
        time.current = seconds;
        if (youtube) { post({ event: "command", func: "seekTo", args: [seconds, true] }); post({ event: "command", func: "playVideo", args: [] }); }
        else { post({ method: "setCurrentTime", value: seconds }); post({ method: "play" }); }
      },
      currentTime: () => time.current,
    };
    return () => { window.removeEventListener("message", receive); playerRef.current = null; };
  }, [origin, playerRef, youtube]);
  function listen() {
    const target = frame.current?.contentWindow;
    if (!target) return;
    if (youtube) target.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), origin);
    else target.postMessage({ method: "addEventListener", value: "timeupdate" }, origin);
  }
  return <div className="document-media-frame" style={embed.width ? { maxWidth: embed.width } : undefined}>
    <iframe ref={frame} src={src} title={embed.alt || (youtube ? "YouTube video" : "Vimeo video")} onLoad={listen} loading="lazy"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
  </div>;
}

export default function DocumentMedia({ markdown, media, readOnly, onChange, onEditSource }: {
  markdown: string;
  media: MediaBlock;
  readOnly?: boolean;
  onChange(markdown: string): void;
  onEditSource(): void;
}) {
  const { embed, timestamps } = media;
  const player = useRef<Player | null>(null);
  const [draft, setDraft] = useState<{ time: string; note: string } | null>(null);
  const [error, setError] = useState("");
  const noteRef = useRef<HTMLInputElement>(null);
  const playable = isPlayable(embed.kind);

  function startTimestamp() {
    const seconds = player.current?.currentTime() ?? 0;
    setError("");
    setDraft({ time: formatTimestamp(seconds), note: "" });
    setTimeout(() => noteRef.current?.focus(), 0);
  }
  function saveTimestamp(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const seconds = parseTimestamp(draft.time);
    if (seconds === null) { setError("Write the time as 1:23 or 1:02:03."); return; }
    onChange(addTimestamp(markdown, seconds, draft.note));
    setDraft(null);
  }

  return <figure className={`document-media is-${embed.kind}`} contentEditable={false}>
    {embed.kind === "youtube" || embed.kind === "vimeo"
      ? <EmbeddedPlayer embed={embed} playerRef={player} />
      : <FileMedia embed={embed} playerRef={player} />}
    {playable && (timestamps.length > 0 || !readOnly) && <figcaption>
      {timestamps.length > 0 && <ol className="document-media-timestamps" aria-label="Timestamps">
        {timestamps.map((timestamp, index) => <li key={`${index}:${timestamp.seconds}`}>
          <button type="button" className="document-media-time" onClick={() => player.current?.seek(timestamp.seconds)} title={`Play from ${formatTimestamp(timestamp.seconds)}`}>{timestamp.label}</button>
          {timestamp.note && <span>{timestamp.note}</span>}
        </li>)}
      </ol>}
      {!readOnly && (draft
        ? <form className="document-media-timestamp-form" onSubmit={saveTimestamp} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setDraft(null); } }}>
          <input aria-label="Time" className="document-media-time-input" value={draft.time} onChange={(event) => setDraft({ ...draft, time: event.target.value })} inputMode="numeric" />
          <input ref={noteRef} aria-label="What happens here" placeholder="What happens here?" value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} />
          <button type="submit">Add</button>
          <button type="button" onClick={() => setDraft(null)}>Cancel</button>
          {error && <p role="alert">{error}</p>}
        </form>
        : <button type="button" className="document-media-add" onClick={startTimestamp} title="Mark the current moment in this video">+ Timestamp</button>)}
    </figcaption>}
    {!readOnly && <button type="button" className="rich-document-source-action" onClick={onEditSource}>Edit embed source</button>}
  </figure>;
}

/** Choose a file to store in the vault, or paste a link to an image or video. */
export function MediaInsertForm({ onInsert, onClose }: { onInsert(markdown: string): void; onClose(): void }) {
  const media = useVaultMedia();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function chooseFile(file: File | undefined) {
    if (!file || !media) return;
    if (!isMediaFile(file)) { setError("Choose an image, video or audio file."); return; }
    setBusy(true);
    setError("");
    try { onInsert(await media.save(file)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "This file could not be saved."); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }
  function insertLink(event: FormEvent) {
    event.preventDefault();
    const markdown = embedMarkdownForUrl(link);
    if (!markdown) { setError("Paste a full https:// link to an image or video."); return; }
    onInsert(markdown);
  }

  return <form className="document-media-insert" onSubmit={insertLink} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    {media && <><button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? "Saving…" : "Choose file…"}</button>
      <input ref={fileRef} type="file" accept="image/*,video/*,audio/*" hidden onChange={(event) => void chooseFile(event.target.files?.[0])} />
      <span>or</span></>}
    <input aria-label="Image or video link" placeholder="Paste a YouTube, Vimeo, image or video link" value={link} onChange={(event) => setLink(event.target.value)} autoFocus />
    <button type="submit" disabled={busy}>Embed</button>
    <button type="button" onClick={onClose}>Cancel</button>
    {error && <p role="alert">{error}</p>}
  </form>;
}
