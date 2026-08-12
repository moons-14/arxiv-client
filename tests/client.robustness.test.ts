import { describe, expect, it } from "vitest";
import {
  type ArxivApiError,
  ArxivClient,
  ArxivNetworkError,
  ArxivValidationError,
  normalizeArxivId,
  not,
  raw,
} from "../src/index";
import type {
  ArxivTransport,
  ArxivTransportResponse,
} from "../src/transport/types";
import { ArxivTransportTimeoutError } from "../src/transport/types";

const response = (
  status: number,
  body = "<feed></feed>",
  headers: Record<string, string> = {},
): ArxivTransportResponse => ({
  status,
  statusText: status === 200 ? "OK" : "Error",
  body,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});

class FakeTransport implements ArxivTransport {
  readonly calls: {
    url: string;
    options: { signal?: AbortSignal; timeoutMs: number };
  }[] = [];
  constructor(...responses: Array<ArxivTransportResponse | Error>) {
    this.responses = responses;
  }
  private readonly responses: Array<ArxivTransportResponse | Error>;
  async get(
    url: string,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<ArxivTransportResponse> {
    this.calls.push({ url, options });
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    return next ?? response(200);
  }
}

const client = (
  transport: ArxivTransport,
  options: ConstructorParameters<typeof ArxivClient>[0] = {},
) => new ArxivClient({ transport, rateLimit: false, retry: false, ...options });

const validFeed = `<feed><id>https://arxiv.org/api/query</id><title>x</title><openSearch:totalResults xmlns:openSearch="x">0</openSearch:totalResults><openSearch:startIndex xmlns:openSearch="x">0</openSearch:startIndex><openSearch:itemsPerPage xmlns:openSearch="x">0</openSearch:itemsPerPage></feed>`;

describe("ArxivClient robustness", () => {
  it("rejects malformed percent escapes, invalid hosts and paths, and accepts bare/legacy IDs", () => {
    expect(() => normalizeArxivId("https://arxiv.org/abs/%ZZ")).toThrow(
      ArxivValidationError,
    );
    expect(() =>
      normalizeArxivId("https://evil.example/abs/2401.00001"),
    ).toThrow(ArxivValidationError);
    expect(() =>
      normalizeArxivId("https://arxiv.org/other/2401.00001"),
    ).toThrow(ArxivValidationError);
    expect(normalizeArxivId("2401.00001")).toBe("2401.00001");
    expect(normalizeArxivId("hep-th/9901001v2")).toBe("hep-th/9901001v2");
    expect(normalizeArxivId("arXiv:hep-th/9901001")).toBe("hep-th/9901001");
    expect(normalizeArxivId("ARXIV:HEP-TH/9901001V2")).toBe("hep-th/9901001v2");
  });

  it("keeps version matching strict while unversioned requests match versioned responses", async () => {
    const feed = (id: string) =>
      `<feed><openSearch:totalResults xmlns:openSearch="x">1</openSearch:totalResults><entry><id>https://arxiv.org/abs/${id}</id><title>x</title><updated>2024-01-01T00:00:00Z</updated><published>2024-01-01T00:00:00Z</published><summary>x</summary><author><name>x</name></author></entry></feed>`;
    const unversioned = await client(
      new FakeTransport(response(200, feed("2401.00001v3"))),
    ).getByIds(["2401.00001"]);
    expect(unversioned.missingIds).toEqual([]);
    const versioned = await client(
      new FakeTransport(response(200, feed("2401.00001v3"))),
    ).getByIds(["2401.00001v2"]);
    expect(versioned.missingIds).toEqual(["2401.00001v2"]);
    const uppercaseVersion = await client(
      new FakeTransport(response(200, feed("2401.00001v2"))),
    ).getByIds(["2401.00001V2"]);
    expect(uppercaseVersion.requestedIds).toEqual(["2401.00001v2"]);
    expect(uppercaseVersion.missingIds).toEqual([]);
  });

  it("turns standalone not into ArxivValidationError and validates runtime options", () => {
    const c = client(new FakeTransport());
    expect(() => c.search({ query: not(raw("all:x")) })).toThrow(
      ArxivValidationError,
    );
    expect(() => c.search({ query: "all:x", sortBy: "bad" as never })).toThrow(
      ArxivValidationError,
    );
    expect(() =>
      c.search({ query: "all:x", sortOrder: "bad" as never }),
    ).toThrow(ArxivValidationError);
    expect(() =>
      c.search({ query: "all:x", ids: "not-array" as never }),
    ).toThrow(ArxivValidationError);
  });

  it("enforces URL length and pagination boundaries, including zero limits", async () => {
    const c = client(new FakeTransport());
    expect(() => c.buildUrl({ query: "x".repeat(9000) })).toThrow(
      ArxivValidationError,
    );
    await expect(
      c.pages({ query: "all:x", start: 30_000 }).next(),
    ).rejects.toThrow(ArxivValidationError);
    await expect(
      c.pages({ query: "all:x", maxPages: 0 }).next(),
    ).resolves.toEqual({ done: true, value: undefined });
    await expect(
      c.pages({ query: "all:x", maxItems: 0 }).next(),
    ).resolves.toEqual({ done: true, value: undefined });
  });

  it("truncates error bodies and marks the truncation", async () => {
    const body = "x".repeat(5000);
    await expect(
      client(new FakeTransport(response(409, body))).search({ query: "all:x" }),
    ).rejects.toMatchObject({
      status: 409,
      body: "x".repeat(4096),
      bodyTruncated: true,
    } satisfies Partial<ArxivApiError>);
  });

  it("clamps huge Retry-After to maxDelayMs", async () => {
    const t = new FakeTransport(
      response(503, "busy", { "retry-after": "999999999" }),
      response(200, validFeed),
    );
    const started = Date.now();
    await client(t, {
      retry: { retries: 1, maxDelayMs: 15, jitter: false },
    }).search({ query: "all:x" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("aborts a queued request immediately and preserves subsequent request order", async () => {
    const t = new FakeTransport(
      response(200, validFeed),
      response(200, validFeed),
      response(200, validFeed),
    );
    const c = new ArxivClient({
      transport: t,
      retry: false,
      rateLimit: { minIntervalMs: 35 },
    });
    const abort = new AbortController();
    const first = c.search({ query: "all:first" });
    const second = c.search({ query: "all:second", signal: abort.signal });
    const third = c.search({ query: "all:third" });
    await new Promise((resolve) => setTimeout(resolve, 3));
    abort.abort("cancelled");
    await expect(second).rejects.toMatchObject({ aborted: true });
    await Promise.all([first, third]);
    expect(
      t.calls.map((call) => new URL(call.url).searchParams.get("search_query")),
    ).toEqual(["all:first", "all:third"]);
  });

  it("exposes custom transport timeout as timedOut network error", async () => {
    const timeout = new ArxivTransportTimeoutError(7);
    const error = await client(new FakeTransport(timeout))
      .search({ query: "all:x" })
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(ArxivNetworkError);
    expect(error).toMatchObject({ timedOut: true, attempts: 1 });
    expect((error as ArxivNetworkError).cause).toBe(timeout);
  });
});
