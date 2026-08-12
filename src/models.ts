/** A person listed in an arXiv entry. */
export interface ArxivAuthor {
  name: string;
  affiliation?: string;
}

export interface ArxivLink {
  href: string;
  rel: string;
  type?: string;
  title?: string;
}

export interface ArxivDoi {
  id: string;
  url: string;
}

export interface ArxivEntry {
  /** The complete URL from the Atom feed. */
  id: string;
  arxivId: string;
  version?: string;
  title: string;
  updated: Date;
  published: Date;
  summary: string;
  authors: ArxivAuthor[];
  categories: string[];
  primaryCategory?: string;
  links: ArxivLink[];
  doi?: ArxivDoi;
  comment?: string;
  journalRef?: string;
  pdfUrl?: string;
  abstractUrl?: string;
}

export interface ArxivFeedMetadata {
  id?: string;
  title?: string;
  updated?: Date;
  [key: string]: string | Date | undefined;
}

export interface ArxivSearchResult {
  entries: ArxivEntry[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  feed?: ArxivFeedMetadata;
  url?: string;
  query?: string;
}

export interface ArxivIdLookupResult extends ArxivSearchResult {
  requestedIds: string[];
  missingIds: string[];
}
