import { describe, expect, it } from "vitest";
import {
  ArxivNetworkError,
  ArxivParseError,
  ArxivValidationError,
  ArxivClient as Client,
  normalizeArxivId,
  type RetryOptions,
} from "../src/client/ArxivClient";
import type {
  ArxivTransport,
  ArxivTransportResponse,
} from "../src/transport/types";

const entry = (id: string, title = "A paper") => `
<entry>
 <id>http://arxiv.org/abs/${id}</id><title>${title}</title>
 <updated>2024-01-01T00:00:00Z</updated><published>2024-01-01T00:00:00Z</published>
 <summary>Summary</summary><author><name>A. Author</name></author>
 <category term="cs.AI"/><link href="http://arxiv.org/abs/${id}" rel="alternate" type="text/html"/>
</entry>`;

const feed = (ids: string[], total = ids.length, start = 0) => `<feed>
 <id>http://arxiv.org/api/query</id><title>arXiv Query</title>
 <openSearch:totalResults xmlns:openSearch="x">${total}</openSearch:totalResults>
 <openSearch:startIndex xmlns:openSearch="x">${start}</openSearch:startIndex>
 <openSearch:itemsPerPage xmlns:openSearch="x">${ids.length}</openSearch:itemsPerPage>
 ${ids.map((id) => entry(id)).join("")}
</feed>`;

class FakeTransport implements ArxivTransport {
  calls: Array<{
    url: string;
    options: { signal?: AbortSignal; timeoutMs: number };
  }> = [];
  private readonly responses: Array<ArxivTransportResponse | Error>;
  constructor(...responses: Array<ArxivTransportResponse | Error>) {
    this.responses = [...responses];
  }
  async get(
    url: string,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<ArxivTransportResponse> {
    this.calls.push({ url, options });
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    return next ?? response(200, feed([]));
  }
}

const response = (
  status: number,
  body: string,
  headers: Record<string, string> = {},
): ArxivTransportResponse => ({
  status,
  statusText: status === 200 ? "OK" : "Error",
  body,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});
const client = (
  transport: ArxivTransport,
  retry: false | RetryOptions = false,
) => new Client({ transport, rateLimit: false, retry });

describe("ArxivClient", () => {
  it("builds URL params with one level of encoding", () => {
    const c = client(new FakeTransport());
    const url = c.buildUrl({
      query: 'all:"hello world" + x',
      ids: ["arXiv:1204.5678v2"],
      start: 2,
      maxResults: 5,
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("search_query")).toBe(
      'all:"hello world" + x',
    );
    expect(parsed.search).not.toContain("%2520");
    expect(parsed.searchParams.get("id_list")).toBe("1204.5678v2");
  });

  it("keeps builder requests immutable and does not leak ids", async () => {
    const transport = new FakeTransport(response(200, feed(["1111.1111"])));
    const c = client(transport);
    const base = c.query("all:one").ids(["1111.1111"]);
    const changed = base.start(7).maxResults(3);
    expect(base.url).not.toContain("start=7");
    expect(changed.url).toContain("start=7");
    const ids = ["1111.1111"];
    c.ids(ids);
    ids.push("2222.2222");
    expect(c.ids(["1111.1111"]).url).not.toContain("2222");
    await base.execute();
    expect(transport.calls[0].url).toContain("id_list=1111.1111");
  });

  it("supports concurrent queries independently", async () => {
    const transport = new FakeTransport(
      response(200, feed(["1"])),
      response(200, feed(["2"])),
    );
    const c = client(transport);
    const [a, b] = await Promise.all([
      c.query("id:1").execute(),
      c.query("id:2").execute(),
    ]);
    expect(a[0].arxivId).toBe("1");
    expect(b[0].arxivId).toBe("2");
  });

  it("returns metadata from executeWithMetadata", async () => {
    const result = await client(
      new FakeTransport(response(200, feed(["1234.1"], 4, 2))),
    )
      .query("all:test")
      .executeWithMetadata();
    expect(result.totalResults).toBe(4);
    expect(result.startIndex).toBe(2);
    expect(result.query).toBe("all:test");
  });

  it("normalizes ids and reports missing entries", async () => {
    expect(normalizeArxivId("https://arxiv.org/pdf/1204.5678v2.pdf")).toBe(
      "1204.5678v2",
    );
    const result = await client(
      new FakeTransport(response(200, feed(["1204.5678v2"]))),
    ).getByIds(["arXiv:1204.5678v2", "https://arxiv.org/abs/2402.00001"]);
    expect(result.requestedIds).toEqual(["1204.5678v2", "2402.00001"]);
    expect(result.missingIds).toEqual(["2402.00001"]);
    expect(
      await client(new FakeTransport(response(200, feed([])))).getById(
        "2402.00001",
      ),
    ).toBeNull();

    const unversioned = await client(
      new FakeTransport(response(200, feed(["1204.5678v2"]))),
    ).getByIds(["1204.5678"]);
    expect(unversioned.missingIds).toEqual([]);
  });

  it("pages and iterate stop at maxItems and page metadata", async () => {
    const t = new FakeTransport(
      response(200, feed(["1", "2"], 5, 0)),
      response(200, feed(["3"], 5, 2)),
    );
    const c = client(t);
    const pages = [];
    for await (const p of c.pages({ query: "all:x", pageSize: 2, maxItems: 3 }))
      pages.push(p);
    expect(pages).toHaveLength(2);
    const t2 = new FakeTransport(
      response(200, feed(["1", "2"], 5, 0)),
      response(200, feed(["3"], 5, 2)),
    );
    const ids: string[] = [];
    for await (const e of client(t2).iterate({
      query: "all:x",
      pageSize: 2,
      maxItems: 3,
    }))
      ids.push(e.arxivId);
    expect(ids).toEqual(["1", "2", "3"]);
    expect(t2.calls).toHaveLength(2);
  });

  it("retries HTTP 503 and honors a short Retry-After", async () => {
    const t = new FakeTransport(
      response(503, "busy", { "retry-after": "0.001" }),
      response(200, feed(["1"])),
    );
    const result = await client(t, {
      retries: 1,
      baseDelayMs: 0,
      jitter: false,
    }).search({ query: "all:x" });
    expect(result.entries).toHaveLength(1);
    expect(t.calls).toHaveLength(2);
  });

  it("does not retry non-retryable HTTP 400", async () => {
    const t = new FakeTransport(response(400, "bad"));
    await expect(
      client(t, { retries: 2, baseDelayMs: 0 }).search({ query: "all:x" }),
    ).rejects.toMatchObject({
      code: "ARXIV_API_ERROR",
      status: 400,
      attempts: 1,
    });
  });

  it("retries network errors and exposes attempts", async () => {
    const t = new FakeTransport(new Error("offline"), new Error("offline"));
    await expect(
      client(t, { retries: 1, baseDelayMs: 0, jitter: false }).search({
        query: "all:x",
      }),
    ).rejects.toMatchObject({ code: "ARXIV_NETWORK_ERROR", attempts: 2 });
  });

  it("wraps malformed feeds as parse errors", async () => {
    await expect(
      client(new FakeTransport(response(200, "not xml"))).search({
        query: "all:x",
      }),
    ).rejects.toBeInstanceOf(ArxivParseError);
  });

  it("passes AbortSignal and aborts before transport", async () => {
    const controller = new AbortController();
    controller.abort("stop");
    const t = new FakeTransport(response(200, feed(["1"])));
    await expect(
      client(t).search({ query: "all:x", signal: controller.signal }),
    ).rejects.toBeInstanceOf(ArxivNetworkError);
    expect(t.calls).toHaveLength(0);
  });

  it("validates search, pagination, retry and constructor options", async () => {
    const c = client(new FakeTransport());
    expect(() => c.search({})).toThrow(ArxivValidationError);
    expect(() => c.buildUrl({ query: "x", maxResults: 0 })).toThrow(
      ArxivValidationError,
    );
    expect(() => c.buildUrl({ query: "x", maxResults: 2001 })).toThrow(
      ArxivValidationError,
    );
    await expect(
      c.pages({ query: "x", pageSize: 0 }).next(),
    ).rejects.toBeInstanceOf(ArxivValidationError);
    expect(
      () => new Client({ baseUrl: "bad", retry: { retries: -1 } }),
    ).toThrow(ArxivValidationError);
  });

  it("customizes timeout and deprecated baseURL", async () => {
    const t = new FakeTransport(response(200, feed([])));
    const c = new Client({
      baseURL: "https://example.test/api",
      transport: t,
      rateLimit: false,
      timeoutMs: 1234,
      retry: false,
    });
    await c.search({ query: "all:x" });
    expect(t.calls[0].options.timeoutMs).toBe(1234);
    expect(t.calls[0].url).toMatch(/^https:\/\/example\.test\/api\?/);
  });
});
