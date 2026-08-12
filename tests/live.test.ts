import { describe, expect, it } from "vitest";
import { ArxivClient } from "../src";

const runLive = process.env.ARXIV_LIVE === "1";

describe.skipIf(!runLive)("arXiv API live smoke tests", () => {
  it("performs three polite requests against real Atom responses", async () => {
    const client = new ArxivClient({
      timeoutMs: 20_000,
      retry: { retries: 1, baseDelayMs: 1_000, jitter: false },
    });
    const ids = ["1706.03762", "1512.03385", "1810.04805"];

    for (const id of ids) {
      const entry = await client.getById(id);
      expect(entry, `Expected arXiv entry ${id}`).not.toBeNull();
      expect(entry?.arxivId).toBe(id);
      expect(entry?.title.trim().length).toBeGreaterThan(0);
      expect(entry?.authors.length).toBeGreaterThan(0);
      expect(entry?.categories.length).toBeGreaterThan(0);
      expect(entry?.published.getTime()).not.toBeNaN();
      expect(entry?.updated.getTime()).not.toBeNaN();
      expect(entry?.abstractUrl).toMatch(/^https?:\/\/arxiv\.org\/abs\//);
      expect(entry?.pdfUrl).toMatch(/^https?:\/\/arxiv\.org\/pdf\//);
    }
  }, 90_000);
});
