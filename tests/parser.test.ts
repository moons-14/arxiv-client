import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseArxivFeed } from "../src/xml/parser";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseArxivFeed", () => {
  it("parses an empty feed and preserves feed metadata/context", () => {
    const result = parseArxivFeed(fixture("empty.xml"), {
      url: "https://export.arxiv.org/api/query?search_query=all%3Afoo",
      query: "all:foo",
      fallbackStart: 7,
    });
    expect(result.entries).toEqual([]);
    expect(result.totalResults).toBe(0);
    expect(result.startIndex).toBe(0);
    expect(result.itemsPerPage).toBe(0);
    expect(result.feed).toMatchObject({
      id: "https://arxiv.org/api/",
      title: "ArXiv Query: search_query=all:foo",
    });
    expect(result.feed?.updated).toBeInstanceOf(Date);
    expect(result.url).toContain("export.arxiv.org");
    expect(result.query).toBe("all:foo");
  });

  it("parses one entry, optional fields, links, authors and categories", () => {
    const [entry] = parseArxivFeed(fixture("single.xml")).entries;
    expect(entry).toMatchObject({
      arxivId: "1234.5678",
      version: "v2",
      title: "A &amp; Useful Paper",
      summary: "A concise abstract.",
      authors: [
        { name: "Ada Lovelace", affiliation: "Analytical Engine Institute" },
        { name: "Alan Turing" },
      ],
      categories: ["cs.AI", "stat.ML"],
      primaryCategory: "cs.AI",
      comment: "12 pages",
      journalRef: "Journal of Tests (2024)",
      pdfUrl: "https://arxiv.org/pdf/1234.5678v2",
      abstractUrl: "https://arxiv.org/abs/1234.5678v2",
      doi: { id: "10.1234/example", url: "https://doi.org/10.1234/example" },
    });
    expect(entry.updated).toEqual(new Date("2024-02-03T04:05:06Z"));
    expect(entry.links).toEqual([
      {
        href: "https://arxiv.org/abs/1234.5678v2",
        rel: "alternate",
        type: "text/html",
      },
      {
        href: "https://arxiv.org/pdf/1234.5678v2",
        rel: "related",
        type: "application/pdf",
      },
    ]);
  });

  it("parses multiple entries and supplies a DOI URL when no DOI link exists", () => {
    const result = parseArxivFeed(fixture("multiple.xml"));
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].doi).toEqual({
      id: "10.5555/no-link",
      url: "https://doi.org/10.5555/no-link",
    });
    expect(result.entries[0].links).toEqual([]);
    expect(result.entries[1].arxivId).toBe("hep-th/9901001");
    expect(result.entries[1].version).toBeUndefined();
  });

  it("rejects empty, malformed, and entries missing required fields", () => {
    expect(() => parseArxivFeed("   ")).toThrow(/empty XML/);
    expect(() => parseArxivFeed(fixture("malformed.xml"))).toThrow();
    expect(() => parseArxivFeed(fixture("missing-required.xml"))).toThrow(
      /missing entry.title/,
    );
  });
});
