import { createGunzip } from "node:zlib";
import { HttpError } from "../lib/errors.mjs";

/**
 * Reads a GitHub tar.gz archive as it downloads, keeping only the files
 * `keep` accepts. GitHub's archives start with a pax header whose comment is
 * the commit, and put every file under one `<repo>-<commit>/` folder, which
 * is stripped from the paths.
 */
export async function readTarGz(stream, { keep, fileByteLimit, totalByteLimit, archiveByteLimit, signal }) {
  const files = [];
  let commit = null, kept = 0, downloaded = 0, skipped = 0, truncated = false;
  let buffer = Buffer.alloc(0);
  let pending = null; // { path, size, remaining, chunks, keep }
  let longName = null, paxPath = null;
  const gunzip = createGunzip();

  const finishFile = () => {
    if (pending.keep) {
      const text = Buffer.concat(pending.chunks).toString("utf8");
      // Binary files slip past the extension check now and then.
      if (!text.includes("\u0000")) { files.push({ path: pending.path, text }); kept += pending.size; } else skipped += 1;
    }
    pending = null;
  };

  const consume = () => {
    while (true) {
      if (pending) {
        const take = Math.min(pending.remaining, buffer.length);
        if (pending.keep && take) pending.chunks.push(buffer.subarray(0, take));
        buffer = buffer.subarray(take); pending.remaining -= take;
        if (pending.remaining > 0) return;
        const padding = (512 - (pending.size % 512)) % 512;
        if (buffer.length < padding) { pending.padding = padding; return; }
        buffer = buffer.subarray(padding);
        const header = pending.header;
        if (header) header(Buffer.concat(pending.chunks));
        else finishFile();
        pending = null;
        continue;
      }
      if (buffer.length < 512) return;
      const block = buffer.subarray(0, 512);
      buffer = buffer.subarray(512);
      if (block.every((byte) => byte === 0)) continue;
      const text = (start, length) => block.subarray(start, start + length).toString("utf8").replace(/\0.*$/su, "");
      const size = parseInt(text(124, 12).trim() || "0", 8) || 0;
      const type = String.fromCharCode(block[156] || 48);
      const prefix = text(345, 155);
      let path = longName ?? paxPath ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
      if (type === "g" || type === "x") {
        pending = { size, remaining: size, chunks: [], keep: true, header(data) {
          const records = parsePax(data.toString("utf8"));
          if (type === "g" && /^[0-9a-f]{40}$/u.test(records.comment ?? "")) commit = records.comment;
          if (type === "x" && records.path) paxPath = records.path;
        } };
        continue;
      }
      if (type === "L") { pending = { size, remaining: size, chunks: [], keep: true, header(data) { longName = data.toString("utf8").replace(/\0.*$/su, ""); } }; continue; }
      longName = null; paxPath = null;
      path = path.split("/").slice(1).join("/");
      const regular = type === "0" || type === "7" || type === "\0";
      const wanted = regular && path && size <= fileByteLimit && keep(path);
      if (regular && path && keep(path) && !wanted) skipped += 1;
      if (wanted && kept + size > totalByteLimit) { truncated = true; pending = { size, remaining: size, chunks: [], keep: false }; continue; }
      pending = { path, size, remaining: size, chunks: [], keep: Boolean(wanted) };
      if (size === 0) { finishFile(); }
    }
  };

  const reader = stream.getReader();
  const done = new Promise((resolve, reject) => {
    gunzip.on("data", (chunk) => { buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk; consume(); });
    gunzip.on("end", resolve);
    gunzip.on("error", () => reject(new HttpError(502, "GitHub sent an archive that could not be read. Try again.")));
  });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done: finished, value } = await reader.read();
      if (finished) break;
      downloaded += value.length;
      if (downloaded > archiveByteLimit) throw new HttpError(413, `This repository is over ${Math.round(archiveByteLimit / 1_000_000)} MB, which is more than Explore can read. Try a smaller repository.`);
      if (!gunzip.write(value)) await new Promise((resolve) => gunzip.once("drain", resolve));
    }
    gunzip.end();
    await done;
  } finally { await reader.cancel().catch(() => {}); }
  return { commit, files, skipped, truncated, downloadedBytes: downloaded };
}

function parsePax(text) {
  const records = {};
  let index = 0;
  while (index < text.length) {
    const space = text.indexOf(" ", index);
    if (space < 0) break;
    const length = Number(text.slice(index, space));
    if (!length) break;
    const record = text.slice(space + 1, index + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    index += length;
  }
  return records;
}
