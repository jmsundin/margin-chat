/**
 * The three @vercel/blob calls that backups use (get, put and list) on an S3-compatible
 * bucket, such as Cloudflare R2, Backblaze B2 or Amazon S3, so the release backup code
 * can write an off-site copy without knowing which provider holds it. Tokens and other
 * Vercel-only options are ignored: the bucket's own keys are given here.
 */
export function createS3BlobSdk({ endpoint, bucket, accessKeyId, secretAccessKey, region = "auto", S3Client = globalThis.Bun?.S3Client, fetchImpl = fetch }) {
  if (!S3Client) throw new Error("Off-site backups run with Bun, which has the S3 client built in.");
  for (const [name, value] of Object.entries({ endpoint, bucket, accessKeyId, secretAccessKey })) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`The off-site backup bucket needs its ${name}.`);
  }
  const client = new S3Client({ endpoint, bucket, accessKeyId, secretAccessKey, region });
  // Providers differ in quoting ETags between listings and reads; backups compare them.
  const etag = (value) => typeof value === "string" && value ? `"${value.replace(/^"|"$/gu, "")}"` : value;
  const missing = (error) => error?.code === "NoSuchKey" || error?.code === "NotFound" || /\b404\b/u.test(error?.message ?? "");

  return {
    async get(pathname) {
      const file = client.file(pathname);
      let stat;
      try { stat = await file.stat(); }
      catch (error) {
        if (missing(error)) return null;
        throw error;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { statusCode: 200, stream: new Response(bytes).body,
        blob: { pathname, etag: etag(stat.etag), size: stat.size, contentType: stat.type || "application/octet-stream" } };
    },
    async put(pathname, bytes, { contentType, allowOverwrite = false } = {}) {
      // Backup objects are written once; a retry finds the first copy and checks it.
      if (!allowOverwrite && await client.exists(pathname)) throw new Error("This backup object already exists.");
      // The client's own write adds "; charset=utf-8" to some types, and backups check the
      // content type exactly, so the upload goes to a short-lived signed URL as given.
      const response = await fetchImpl(client.presign(pathname, { method: "PUT", expiresIn: 3600 }), {
        method: "PUT", body: bytes, headers: { "content-type": contentType ?? "application/octet-stream" },
      });
      if (!response.ok) throw new Error(`The off-site bucket refused an upload (HTTP ${response.status}).`);
      return { pathname };
    },
    async list({ prefix = "", cursor, limit = 1000, mode = "expanded" } = {}) {
      const result = await client.list({ prefix, maxKeys: limit, ...(cursor ? { continuationToken: cursor } : {}), ...(mode === "folded" ? { delimiter: "/" } : {}) });
      return {
        blobs: (result.contents ?? []).map((object) => ({ pathname: object.key, etag: etag(object.eTag), size: object.size })),
        folders: (result.commonPrefixes ?? []).map((folder) => folder.prefix),
        hasMore: Boolean(result.isTruncated),
        cursor: result.nextContinuationToken,
      };
    },
  };
}
