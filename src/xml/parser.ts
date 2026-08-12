import { XMLParser, XMLValidator } from "fast-xml-parser";
import type {
  ArxivAuthor,
  ArxivEntry,
  ArxivFeedMetadata,
  ArxivLink,
  ArxivSearchResult,
} from "../models";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
  parseTagValue: false,
  processEntities: {
    enabled: true,
    maxEntitySize: 1_000,
    maxExpansionDepth: 5,
    maxTotalExpansions: 1_000,
    maxExpandedLength: 100_000,
    maxEntityCount: 10,
  },
});

type XmlNode = unknown;
const isRecord = (value: XmlNode): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const first = (value: XmlNode): XmlNode =>
  Array.isArray(value) ? value[0] : value;

function text(value: XmlNode): string | undefined {
  value = first(value);
  if (value === undefined || value === null) return undefined;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    const result = String(value).trim();
    return result || undefined;
  }
  if (isRecord(value)) {
    return text(value["#text"] ?? value.text ?? value.value);
  }
  return undefined;
}

function requiredText(value: XmlNode, field: string): string {
  const result = text(value);
  if (!result) throw new Error(`Invalid arXiv feed: missing ${field}`);
  return result;
}

function compactText(value: XmlNode): string | undefined {
  return text(value)?.replace(/\s+/g, " ").trim() || undefined;
}

function requiredCompactText(value: XmlNode, field: string): string {
  const result = compactText(value);
  if (!result) throw new Error(`Invalid arXiv feed: missing ${field}`);
  return result;
}

function asArray(value: XmlNode): XmlNode[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function attr(node: XmlNode, name: string): string | undefined {
  return isRecord(node) ? text(node[`@_${name}`]) : undefined;
}

function date(value: XmlNode, field: string): Date {
  const raw = requiredText(value, field);
  const result = new Date(raw);
  if (Number.isNaN(result.getTime()))
    throw new Error(`Invalid arXiv feed: invalid ${field}`);
  return result;
}

function number(value: XmlNode, fallback: number, field: string): number {
  const raw = text(value);
  if (!raw) return fallback;
  const result = Number(raw);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`Invalid arXiv feed: invalid ${field}`);
  }
  return result;
}

function arxivIdentity(feedId: string): { arxivId: string; version?: string } {
  let candidate = feedId
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/$/, "");
  try {
    const parsed = new URL(candidate);
    candidate = decodeURIComponent(parsed.pathname).replace(
      /^\/(?:abs|pdf)\//,
      "",
    );
  } catch {
    candidate = candidate.replace(/^.*\/(?:abs|pdf)\//, "");
  }
  candidate = candidate.replace(/\.pdf$/i, "").replace(/^v\d+\//i, "");
  const versionMatch = candidate.match(/(v\d+)$/i);
  return versionMatch
    ? {
        arxivId: candidate.slice(0, -versionMatch[1].length).toLowerCase(),
        version: versionMatch[1].toLowerCase(),
      }
    : { arxivId: candidate.toLowerCase() };
}

function parseAuthor(node: XmlNode): ArxivAuthor {
  if (!isRecord(node)) throw new Error("Invalid arXiv feed: invalid author");
  const affiliation = compactText(node["arxiv:affiliation"]);
  return {
    name: requiredCompactText(node.name, "author.name"),
    ...(affiliation ? { affiliation } : {}),
  };
}

function parseLink(node: XmlNode): ArxivLink | undefined {
  const href = attr(node, "href");
  if (!href) return undefined;
  const rel = attr(node, "rel") ?? "alternate";
  const type = attr(node, "type");
  const title = attr(node, "title");
  return {
    href,
    rel,
    ...(type ? { type } : {}),
    ...(title ? { title } : {}),
  };
}

function parseEntry(node: XmlNode): ArxivEntry {
  if (!isRecord(node)) throw new Error("Invalid arXiv feed: invalid entry");
  const id = requiredText(node.id, "entry.id");
  const identity = arxivIdentity(id);
  const links = asArray(node.link)
    .map(parseLink)
    .filter((link): link is ArxivLink => link !== undefined);
  const doiId = compactText(node["arxiv:doi"]);
  const doiLink = links.find(
    (link) =>
      link.title?.toLowerCase() === "doi" || link.href.includes("doi.org/"),
  );
  const pdfUrl = links.find(
    (link) =>
      link.type === "application/pdf" || link.title?.toLowerCase() === "pdf",
  )?.href;
  const abstractUrl = links.find(
    (link) =>
      link.rel === "alternate" && (!link.type || link.type === "text/html"),
  )?.href;
  const primaryCategory = attr(node["arxiv:primary_category"], "term");
  const comment = compactText(node["arxiv:comment"]);
  const journalRef = compactText(node["arxiv:journal_ref"]);
  return {
    id,
    ...identity,
    title: requiredCompactText(node.title, "entry.title"),
    updated: date(node.updated, "entry.updated"),
    published: date(node.published, "entry.published"),
    summary: requiredCompactText(node.summary, "entry.summary"),
    authors: asArray(node.author).map(parseAuthor),
    categories: asArray(node.category).map((category) => {
      const term = attr(category, "term");
      return requiredText(term, "category.term");
    }),
    ...(primaryCategory ? { primaryCategory } : {}),
    links: links.filter((link) => link !== doiLink),
    ...(doiId
      ? {
          doi: {
            id: doiId,
            url:
              doiLink?.href ??
              `https://doi.org/${doiId.split("/").map(encodeURIComponent).join("/")}`,
          },
        }
      : {}),
    ...(pdfUrl ? { pdfUrl } : {}),
    ...(abstractUrl ? { abstractUrl } : {}),
    ...(comment ? { comment } : {}),
    ...(journalRef ? { journalRef } : {}),
  };
}

function openSearchValue(feed: Record<string, unknown>, name: string): XmlNode {
  return feed[`opensearch:${name}`] ?? feed[`openSearch:${name}`];
}

export function parseArxivFeed(
  xml: string,
  context?: { url?: string; query?: string; fallbackStart?: number },
): ArxivSearchResult {
  if (!xml?.trim()) throw new Error("Invalid arXiv feed: empty XML");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error(
      "Invalid arXiv feed: document type declarations are not allowed",
    );
  }
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(
      `Invalid arXiv feed: malformed XML (${validation.err.msg})`,
    );
  }
  const document = parser.parse(xml) as Record<string, unknown>;
  const feed = document.feed ?? document["atom:feed"];
  if (!isRecord(feed)) throw new Error("Invalid arXiv feed: missing feed");
  const entries = asArray(feed.entry).map(parseEntry);
  const feedMetadata: ArxivFeedMetadata = {};
  for (const key of ["id", "title"]) {
    const value = text(feed[key]);
    if (value) feedMetadata[key] = value;
  }
  const updated = text(feed.updated);
  if (updated) feedMetadata.updated = date(updated, "feed.updated");
  return {
    entries,
    totalResults: number(
      openSearchValue(feed, "totalResults"),
      entries.length,
      "totalResults",
    ),
    startIndex: number(
      openSearchValue(feed, "startIndex"),
      context?.fallbackStart ?? 0,
      "startIndex",
    ),
    itemsPerPage: number(
      openSearchValue(feed, "itemsPerPage"),
      entries.length,
      "itemsPerPage",
    ),
    ...(Object.keys(feedMetadata).length ? { feed: feedMetadata } : {}),
    ...(context?.url ? { url: context.url } : {}),
    ...(context?.query ? { query: context.query } : {}),
  };
}
