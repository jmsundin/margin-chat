import { HttpError } from "../lib/errors.mjs";

/**
 * PubMed through NCBI's E-utilities: free, no account; 3 requests a second
 * without a key, 10 with NCBI_API_KEY. Articles come back as XML, read here
 * for the few fields the library keeps.
 */
const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const TOOL = "margin-chat";

function withKey(params, env) {
  const search = new URLSearchParams({ ...params, tool: TOOL });
  if (env.NCBI_API_KEY) search.set("api_key", env.NCBI_API_KEY);
  return search;
}

async function eutils(path, params, { env, fetchImpl, signal }) {
  const response = await fetchImpl(`${EUTILS}/${path}?${withKey(params, env)}`, { signal, headers: { Accept: path.startsWith("esearch") ? "application/json" : "application/xml" } });
  if (response.status === 429) throw new HttpError(503, "PubMed is busy right now. Try again in a minute.");
  if (!response.ok) throw new HttpError(502, `PubMed answered ${response.status}.`);
  return response;
}

/** PubMed ids for `query`, most relevant first, from `start`. */
export async function searchPubMed({ query, start = 0, count = 200, env = process.env, fetchImpl = fetch, signal }) {
  const response = await eutils("esearch.fcgi", { db: "pubmed", term: query, retstart: String(start), retmax: String(count), retmode: "json", sort: "relevance" }, { env, fetchImpl, signal });
  const payload = await response.json();
  const result = payload?.esearchresult;
  if (!result || !Array.isArray(result.idlist)) throw new HttpError(502, "PubMed returned an unexpected answer.");
  return { total: Number(result.count) || 0, ids: result.idlist.filter((id) => /^\d{1,12}$/.test(id)) };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
function text(xml) {
  return xml.replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code) => code[0] === "#"
      ? String.fromCodePoint(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1)))
      : ENTITIES[code.toLowerCase()] ?? whole)
    .replace(/\s+/g, " ").trim();
}
const first = (xml, pattern) => { const match = xml.match(pattern); return match ? text(match[1]) : ""; };

/** One <PubmedArticle> element as the library keeps it. */
export function parsePubMedArticle(xml) {
  const pmid = first(xml, /<PMID[^>]*>([\s\S]*?)<\/PMID>/);
  if (!/^\d+$/.test(pmid)) return null;
  const title = first(xml, /<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/) || first(xml, /<VernacularTitle[^>]*>([\s\S]*?)<\/VernacularTitle>/);
  const abstract = [...xml.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map(([, attributes, body]) => {
    const label = attributes.match(/Label="([^"]+)"/)?.[1];
    return `${label ? `${text(label)}: ` : ""}${text(body)}`;
  }).join("\n\n");
  const pubDate = xml.match(/<PubDate>([\s\S]*?)<\/PubDate>/)?.[1] ?? "";
  const year = Number(first(pubDate, /<Year>(\d{4})<\/Year>/) || pubDate.match(/(\d{4})/)?.[1]) || null;
  const doi = first(xml, /<ArticleId IdType="doi">([\s\S]*?)<\/ArticleId>/) || first(xml, /<ELocationID EIdType="doi"[^>]*>([\s\S]*?)<\/ELocationID>/);
  const authors = [...xml.matchAll(/<Author(?:\s[^>]*)?>([\s\S]*?)<\/Author>/g)].map(([, body]) => {
    const last = first(body, /<LastName>([\s\S]*?)<\/LastName>/), initials = first(body, /<Initials>([\s\S]*?)<\/Initials>/);
    return last ? `${last}${initials ? ` ${initials}` : ""}` : first(body, /<CollectiveName>([\s\S]*?)<\/CollectiveName>/);
  }).filter(Boolean);
  const topics = [...xml.matchAll(/<DescriptorName[^>]*MajorTopicYN="Y"[^>]*>([\s\S]*?)<\/DescriptorName>/g)].map(([, body]) => text(body));
  return {
    id: `pubmed:${pmid}`,
    title: title.slice(0, 1000),
    abstract: abstract.slice(0, 8000),
    year,
    journal: first(xml, /<Journal>[\s\S]*?<Title>([\s\S]*?)<\/Title>/).slice(0, 300) || null,
    doi: doi.slice(0, 200) || null,
    authors: (authors.length > 3 ? [...authors.slice(0, 3), "et al."] : authors).join(", ").slice(0, 300) || null,
    topics: [...new Set(topics)].slice(0, 12),
  };
}

/** Articles for PubMed ids, in no particular order; ids PubMed no longer has are left out. */
export async function fetchPubMedArticles({ ids, env = process.env, fetchImpl = fetch, signal }) {
  if (!ids.length) return [];
  const response = await eutils("efetch.fcgi", { db: "pubmed", id: ids.join(","), retmode: "xml" }, { env, fetchImpl, signal });
  const xml = await response.text();
  return [...xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g)].map(([, body]) => parsePubMedArticle(body)).filter(Boolean);
}
