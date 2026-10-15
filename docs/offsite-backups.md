# Off-site backups

Every day at 07:23 UTC, the **Off-site backup** workflow copies the production vault store (Vercel Blob) to a bucket at another provider. Cloudflare R2 is the default; any S3-compatible bucket works, such as Backblaze B2 or Amazon S3. A copy at another company still exists if the Vercel account, its Blob stores or its tokens are lost, deleted or misused. Release backups ([production-releases.md](production-releases.md)) still run as before. They live in the same Vercel account and only run for releases that change data.

Each run is a complete, verified backup in the same format as a release backup: every user's manifest is captured once, the files it refers to are copied and checked, and an inventory is saved last. A file unchanged since an earlier backup (same Blob ETag) points at that backup's copy instead of being copied again, so a day with few edits uploads little. Nothing is ever deleted or overwritten in the bucket. The workflow only reads the production store.

The Postgres database (accounts, billing, search index) is not part of this backup. Its only copies are Neon's own restore window and the release recovery branches.

## Setting it up (Cloudflare R2)

1. In the Cloudflare dashboard, open **R2 Object Storage** and create a bucket, for example `margin-chat-backups`.
2. In the bucket's **Settings**, add a **Bucket lock rule** for all objects (no prefix) that retains objects for **30 days**. Nobody can delete or replace a backup during that time, not even with a leaked key.
3. Back in R2, open **Manage API tokens** and create a token with **Object Read & Write** permission, applied to that bucket only. Copy the **Access Key ID**, the **Secret Access Key** and the **S3 endpoint** (`https://<account id>.r2.cloudflarestorage.com`).
4. In GitHub, open the repository's **Settings → Environments → production** and add these secrets (repository secrets work too):

   | Secret | Value |
   | --- | --- |
   | `OFFSITE_BACKUP_S3_ENDPOINT` | The S3 endpoint from step 3 |
   | `OFFSITE_BACKUP_S3_BUCKET` | The bucket name |
   | `OFFSITE_BACKUP_S3_ACCESS_KEY_ID` | The Access Key ID |
   | `OFFSITE_BACKUP_S3_SECRET_ACCESS_KEY` | The Secret Access Key |
   | `OFFSITE_BACKUP_S3_REGION` | Optional. Leave unset for R2 (`auto`); set the bucket's region for S3 or B2 |

5. Open **Actions → Off-site backup → Run workflow** to make the first copy now. Later runs happen on their own.

Until the secrets are added, the daily run fails with a message naming the missing ones, so a backup that isn't running is never silent.

R2 costs nothing to download from. Storage beyond the free 10 GB is about $0.015 per GB-month. Never add a lifecycle rule that deletes objects under `releases/`. A newer backup's inventory points at files saved by older backups, as in the release backup store.

## Restoring

Restore into an empty folder on any machine with Bun and this repository:

```sh
OFFSITE_BACKUP_S3_ENDPOINT=… OFFSITE_BACKUP_S3_BUCKET=… \
OFFSITE_BACKUP_S3_ACCESS_KEY_ID=… OFFSITE_BACKUP_S3_SECRET_ACCESS_KEY=… \
bun scripts/offsite-backup.mjs restore ./restored-vaults
```

That restores the newest complete backup. To restore an older day, add its ID, such as `20261015072300-daily`; the IDs are the folder names under `releases/` in the bucket. Every file is checked against the backup's inventory (size, SHA-256, and each vault manifest's references) before the command reports success. A damaged or missing file stops the restore with an error.

The folder is laid out exactly like the Blob store, so a local server can open it as its vault store with `VAULT_STORAGE_DIR=./restored-vaults`. The folder also holds `restored-from-<id>.json`, the backup's inventory, which records every file's content type for an upload to a new Blob store.
