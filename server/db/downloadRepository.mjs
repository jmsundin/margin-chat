export async function recordDesktopDownload(client, download) {
  await client.query(
    `insert into marginchat_desktop_downloads (
       target, platform, version, asset_name, user_id, ip_address, user_agent, os,
       accept_language, referer, source, country, region, city, postal_code,
       latitude, longitude, timezone)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      download.target, download.platform, download.version, download.assetName, download.userId ?? null,
      download.ipAddress ?? null, download.userAgent ?? null, download.os ?? null,
      download.acceptLanguage ?? null, download.referer ?? null, download.source ?? null,
      download.country ?? null, download.region ?? null, download.city ?? null, download.postalCode ?? null,
      download.latitude ?? null, download.longitude ?? null, download.timezone ?? null,
    ],
  );
}
