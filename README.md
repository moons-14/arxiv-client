# arxiv-client

A small, typed TypeScript client for the arXiv Atom API. It provides a modern, stateless client API, composable query helpers, metadata-aware results, ID lookups, lazy pagination, retries, rate limiting, cancellation, and an immutable builder for existing applications.

## Installation

```bash
npm install arxiv-client
```

Node.js 22 or newer is required. The package ships ESM, CommonJS, and TypeScript declarations.

## Quick start

```ts
import {
  ArxivClient,
  and,
  author,
  category,
  title,
} from "arxiv-client";

const client = new ArxivClient();
const result = await client.search({
  query: and(category("cs.AI"), title("reinforcement learning"), author("Sutton")),
  maxResults: 10,
  sortBy: "lastUpdatedDate",
  sortOrder: "descending",
});

console.log(`${result.entries.length} of ${result.totalResults} results`);
for (const paper of result.entries) {
  console.log(paper.arxivId, paper.title, paper.pdfUrl);
}
```

`search()` returns an `ArxivSearchResult`, including `entries`, `totalResults`, `startIndex`, `itemsPerPage`, the normalized `query`, and the request `url`. Pass a query AST, an arXiv search string, or IDs; a query and IDs may be combined when the API request needs both.

## Migration from 0.0.x

The current client keeps the familiar fluent entry point while making the request pipeline stateless and typed. The following changes are the ones most likely to affect an existing 0.0.x application:

- Query helpers such as `title()`, `author()`, and `category()` now return serializable query AST nodes, rather than serialized strings. Compose them with `and()`, `or()`, `not()`, or `andNot()`, and pass the resulting AST to `search()` or `query()`. If an application already stores serialized arXiv expressions, pass them as strings or wrap them with `raw()`.
- Builder methods are immutable. Calls such as `start()`, `maxResults()`, and `sortBy()` return a new `ArxivRequest`; they do not modify the request they were called on. Keep the returned request, or derive multiple requests from a shared base request.
- `execute()` continues to resolve to an array of entries. Use `executeWithMetadata()` when you need `totalResults`, pagination metadata, the normalized query, or the request URL.
- Node.js 22 or newer is required. The package publishes ESM, CommonJS, and TypeScript declarations.
- Failures are represented by typed `ArxivError` subclasses: `ArxivValidationError`, `ArxivApiError`, `ArxivNetworkError`, and `ArxivParseError`. Check `error.code` for the stable code (`ARXIV_*`) instead of parsing error messages.
- ID lookup is intentionally strict. `getById()` and `getByIds()` accept modern or legacy arXiv IDs, `abs`/`pdf` URLs on `arxiv.org`, and `arXiv:`-prefixed IDs; malformed IDs and URLs now raise `ArxivValidationError`.

For example, a mutable-style reuse pattern should become:

```ts
const base = arxivClient.query(category("cs.AI")).maxResults(10);
const newest = base.sortBy("lastUpdatedDate");
const entries = await newest.execute();
const metadata = await base.executeWithMetadata();
```

## Query helpers

Query helpers produce a serializable query AST. They can be composed with `and`, `or`, `not`, and `andNot`:

```ts
import { and, andNot, abstract, category, submittedBetween, title } from "arxiv-client";

const query = andNot(
  and(category("cs.LG"), title("transformer")),
  abstract("survey"),
);

const recent = submittedBetween(
  new Date("2025-01-01T00:00:00Z"),
  new Date("2025-12-31T23:59:00Z"),
);

await client.search({ query: and(query, recent), maxResults: 5 });
```

Available field helpers are `title`, `author`, `abstract`, `comment`, `journalReference`, `category`, `reportNumber`, and `all`. Use `raw("...")` for an already serialized arXiv expression. `submittedDate` accepts `Date` values or `YYYYMMDD` / `YYYYMMDDHHmm` strings.

## IDs and metadata

`getById()` accepts an ID, an `abs` URL, a PDF URL, or an `arXiv:` identifier and returns one entry or `null`. `getByIds()` returns the normal metadata plus `requestedIds` and `missingIds`:

```ts
const paper = await client.getById("2401.12345");
const lookup = await client.getByIds(["2401.12345", "arXiv:1706.03762"]);
console.log(lookup.missingIds);
```

## Pagination and async iteration

Use `pages()` when page metadata matters, or `iterate()` for a flat lazy stream. Both stop without loading the complete result set into memory and support `pageSize`, `maxPages`, and `maxItems`:

```ts
for await (const paper of client.iterate({
  query: category("cs.AI"),
  pageSize: 25,
  maxItems: 50,
})) {
  console.log(paper.title);
}

for await (const page of client.pages({ query: title("diffusion"), pageSize: 10, maxPages: 2 })) {
  console.log(page.startIndex, page.entries.length, page.totalResults);
}
```

## Immutable builder compatibility

The default `arxivClient` and `client.query()` keep the original fluent API. Every builder method returns a new request, so a base request can safely be reused:

```ts
import arxivClient, { category, title } from "arxiv-client";

const base = arxivClient.query(category("cs.AI")).maxResults(5);
const newest = await base.sortBy("lastUpdatedDate").executeWithMetadata();
const entries = await base.sortOrder("descending").execute();
console.log(newest.totalResults, entries.length);
```

The usual calls are `start()`, `maxResults()`, `sortBy()`, `sortOrder()`, `signal()`, `timeout()`, `execute()` (entries only), `executeWithMetadata()` (full result), and `iterate()`. For clarity, a reusable request normally ends with:

```ts
const entries = await base.sortOrder("descending").execute();
```

## Reliability and transport options

The client waits three seconds between requests by default, matching arXiv's public API guidance. Keep that default for normal use and cache results where possible. Configure retries, timeout, and throttling explicitly when needed:

```ts
const client = new ArxivClient({
  timeoutMs: 20_000,
  retry: { retries: 3, baseDelayMs: 500, maxDelayMs: 8_000, jitter: true },
  rateLimit: { minIntervalMs: 3_000 },
  headers: { "User-Agent": "my-research-tool/1.0 (contact@example.com)" },
});
```

Set `retry: false` or `rateLimit: false` only when your environment has an equivalent policy. `signal` on a search/pagination request (or `.signal()` on a builder) supports `AbortController`. A request-level `timeoutMs` overrides the client default. Supply `fetch` to the built-in transport for a custom fetch implementation, or supply a complete `transport` implementing `get(url, { signal, timeoutMs })` for tracing, caching, or a proxy.

## Security and request limits

The built-in transport refuses response bodies larger than 32 MiB by default, both when the server advertises a `Content-Length` and while a streamed response is being read. Set `maxResponseBytes` to a different positive integer when a trusted deployment needs another limit; this option applies only to the built-in transport and is ignored when a custom `transport` is supplied.

Requests are limited to an 8,192-character URL, a 2,000-result page, and arXiv's practical 30,000-result window. Split large ID lists or queries and use `pages()`/`iterate()` when necessary. These client-side limits protect the request and memory budgets; they do not change limits enforced by arXiv.

`baseUrl` is intended for a trusted arXiv-compatible endpoint and must use `http:` or `https:`. Treat it as sensitive configuration: a custom endpoint receives query terms, IDs, and any configured headers. Prefer HTTPS and do not point it at an untrusted URL. The legacy `baseURL` spelling remains accepted as a deprecated alias.

## Errors

All client failures are typed `ArxivError` instances. Handle `ArxivValidationError` for invalid options, `ArxivApiError` for non-success HTTP responses (including `status`, `attempts`, and `retryAfterMs`), `ArxivNetworkError` for transport/timeout/abort failures, and `ArxivParseError` for malformed Atom responses. Every error has a stable `code` such as `ARXIV_API_ERROR`.

## Compact API reference

- `new ArxivClient(options?)`, `createArxivClient(options?)`, `arxivClient`
- `client.search(options) -> Promise<ArxivSearchResult>`
- `client.query(...queries)`, `client.ids(ids) -> ArxivRequest`
- `client.getById(id, options?)`, `client.getByIds(ids, options?)`
- `client.pages(options)`, `client.iterate(options)`
- `client.buildUrl(options) -> string`
- `ArxivRequest.query`, `ids`, `start`, `maxResults`, `sortBy`, `sortOrder`, `signal`, `timeout`, `url`, `execute`, `executeWithMetadata`, `iterate`

The arXiv API documents a maximum practical result window of 30,000 and this client caps a single page at 2,000 results. Use pagination and respect the three-second request interval to be a good API citizen.

## Live example

The repository contains a small live example (`pnpm run run:example`). It makes one request with `maxResults: 3` and prints metadata. Network access to `export.arxiv.org` is required.

## License

MIT
