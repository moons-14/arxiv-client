import type {
  ArxivEntry,
  ArxivIdLookupResult,
  ArxivSearchResult,
} from "../models";
import { and, type Query, raw, serializeQuery } from "../query";
import { FetchTransport } from "../transport/fetchTransport";
import {
  type ArxivFetch,
  ArxivResponseTooLargeError,
  type ArxivTransport,
  ArxivTransportTimeoutError,
} from "../transport/types";
import { parseArxivFeed } from "../xml/parser";
import {
  ArxivApiError,
  ArxivNetworkError,
  ArxivParseError,
  ArxivValidationError,
} from "./errors";

const DEFAULT_BASE_URL = "https://export.arxiv.org/api/query";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MIN_INTERVAL_MS = 3_000;
const DEFAULT_RETRY_STATUSES = [429, 500, 502, 503, 504] as const;
const MAX_PAGE_SIZE = 2_000;
const MAX_RESULT_WINDOW = 30_000;
const MAX_URL_LENGTH = 8_192;
const MAX_ERROR_BODY_LENGTH = 4_096;

export type SortBy = "relevance" | "lastUpdatedDate" | "submittedDate";
export type SortOrder = "ascending" | "descending";
export type QueryInput = Query | string;

export interface RetryOptions {
  /** Number of additional attempts after the initial request. */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  statuses?: readonly number[];
}

export interface RateLimitOptions {
  /** Minimum delay between requests made by this client instance. */
  minIntervalMs?: number;
}

export interface ArxivClientOptions {
  baseUrl?: string;
  /** @deprecated Use `baseUrl`. */
  baseURL?: string;
  timeoutMs?: number;
  retry?: false | RetryOptions;
  rateLimit?: false | RateLimitOptions;
  transport?: ArxivTransport;
  /** Used by the built-in transport. Ignored when `transport` is supplied. */
  fetch?: ArxivFetch;
  headers?: Readonly<Record<string, string>>;
  /** Maximum response size accepted by the built-in transport. Defaults to 32 MiB. */
  maxResponseBytes?: number;
}

export interface ArxivSearchOptions {
  query?: QueryInput;
  ids?: readonly string[];
  start?: number;
  maxResults?: number;
  sortBy?: SortBy;
  sortOrder?: SortOrder;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ArxivPaginationOptions
  extends Omit<ArxivSearchOptions, "start" | "maxResults"> {
  start?: number;
  pageSize?: number;
  maxPages?: number;
  maxItems?: number;
}

export interface ArxivIterationOptions {
  pageSize?: number;
  maxPages?: number;
  maxItems?: number;
  signal?: AbortSignal;
}

interface ResolvedRetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  statuses: ReadonlySet<number>;
}

interface RequestState {
  query?: QueryInput;
  ids?: readonly string[];
  start: number;
  maxResults: number;
  sortBy?: SortBy;
  sortOrder?: SortOrder;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ArxivValidationError(`${name} must be a non-negative integer`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ArxivValidationError(`${name} must be a positive integer`);
  }
}

function normalizeQuery(query: QueryInput | undefined): string | undefined {
  if (query === undefined) return undefined;
  let value: string;
  try {
    value = typeof query === "string" ? query.trim() : serializeQuery(query);
  } catch (cause) {
    throw new ArxivValidationError("Invalid arXiv query", { cause });
  }
  if (!value) throw new ArxivValidationError("query must not be empty");
  return value;
}

function queryFrom(inputs: readonly QueryInput[]): QueryInput {
  if (inputs.length === 0) {
    throw new ArxivValidationError("query() requires at least one query");
  }
  const queries = inputs.map((input) =>
    typeof input === "string" ? raw(input) : input,
  );
  return queries.length === 1 ? queries[0] : and(...queries);
}

function stripArxivUrl(value: string): string {
  if (typeof value !== "string") {
    throw new ArxivValidationError("arXiv ID must be a string");
  }
  const trimmed = value.trim();
  if (!trimmed) throw new ArxivValidationError("arXiv ID must not be empty");

  let candidate = trimmed.replace(/^arxiv:/i, "");
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const url = new URL(candidate);
      if (
        !["arxiv.org", "www.arxiv.org"].includes(url.hostname.toLowerCase())
      ) {
        throw new Error("Unexpected host");
      }
      const path = decodeURIComponent(url.pathname);
      const pathMatch = path.match(/^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?$/i);
      if (!pathMatch) throw new Error("Unexpected arXiv paper path");
      candidate = pathMatch[1];
    } catch (cause) {
      throw new ArxivValidationError(`Invalid arXiv URL: ${trimmed}`, {
        cause,
      });
    }
  }

  candidate = candidate
    .replace(/[?#].*$/, "")
    .replace(/\.pdf$/i, "")
    .replace(/^\/+|\/+$/g, "");
  const modernId = /^\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}(?:v[1-9]\d*)?$/i;
  const legacyId =
    /^[a-z][a-z0-9.-]*\/\d{2}(?:0[1-9]|1[0-2])\d{3}(?:v[1-9]\d*)?$/i;
  if (
    candidate.length > 128 ||
    (!modernId.test(candidate) && !legacyId.test(candidate))
  ) {
    throw new ArxivValidationError(`Invalid arXiv ID: ${trimmed}`);
  }
  return candidate.toLowerCase();
}

/** Accept an arXiv ID, abs URL, PDF URL, or `arXiv:` identifier. */
export function normalizeArxivId(value: string): string {
  return stripArxivUrl(value);
}

function entryIdentifier(entry: ArxivEntry): string {
  return `${entry.arxivId}${entry.version ?? ""}`;
}

function wasReturned(
  requestedId: string,
  entries: readonly ArxivEntry[],
): boolean {
  const hasVersion = /v[1-9]\d*$/i.test(requestedId);
  return entries.some((entry) =>
    hasVersion
      ? entryIdentifier(entry) === requestedId
      : entry.arxivId === requestedId,
  );
}

function parseRetryAfter(
  value: string | null,
  maxDelayMs: number,
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, maxDelayMs);
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.min(Math.max(0, timestamp - Date.now()), maxDelayMs);
}

function abortError(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  );
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError(signal as AbortSignal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

class RequestInterval {
  readonly #intervalMs: number;
  #nextRequestAt = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(intervalMs: number) {
    this.#intervalMs = intervalMs;
  }

  async wait(signal?: AbortSignal): Promise<void> {
    let release = () => {};
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    let acquiredTurn = false;
    try {
      try {
        await abortable(previous, signal);
        acquiredTurn = true;
      } catch (cause) {
        previous.then(release, release);
        throw cause;
      }
      await delay(Math.max(0, this.#nextRequestAt - Date.now()), signal);
      this.#nextRequestAt = Date.now() + this.#intervalMs;
    } finally {
      if (acquiredTurn) release();
    }
  }
}

function resolveRetryOptions(
  options: false | RetryOptions | undefined,
): ResolvedRetryOptions {
  const retry = options === false ? { retries: 0 } : (options ?? {});
  const retries = retry.retries ?? 2;
  const baseDelayMs = retry.baseDelayMs ?? 500;
  const maxDelayMs = retry.maxDelayMs ?? 10_000;
  assertNonNegativeInteger(retries, "retry.retries");
  assertNonNegativeInteger(baseDelayMs, "retry.baseDelayMs");
  assertNonNegativeInteger(maxDelayMs, "retry.maxDelayMs");
  const statuses = retry.statuses ?? DEFAULT_RETRY_STATUSES;
  if (
    !Array.isArray(statuses) ||
    statuses.some(
      (status) => !Number.isSafeInteger(status) || status < 100 || status > 599,
    )
  ) {
    throw new ArxivValidationError(
      "retry.statuses must contain valid HTTP status codes",
    );
  }
  return {
    retries,
    baseDelayMs,
    maxDelayMs,
    jitter: retry.jitter ?? true,
    statuses: new Set(statuses),
  };
}

function retryDelay(
  retry: ResolvedRetryOptions,
  failedAttempt: number,
): number {
  const exponential = Math.min(
    retry.maxDelayMs,
    retry.baseDelayMs * 2 ** Math.max(0, failedAttempt - 1),
  );
  return retry.jitter
    ? Math.round(exponential * (0.5 + Math.random() * 0.5))
    : exponential;
}

function validateSearchOptions(
  options: ArxivSearchOptions,
): Required<Pick<RequestState, "start" | "maxResults">> {
  if (!options || typeof options !== "object") {
    throw new ArxivValidationError("search options must be an object");
  }
  const start = options.start ?? 0;
  const maxResults = options.maxResults ?? 10;
  assertNonNegativeInteger(start, "start");
  assertPositiveInteger(maxResults, "maxResults");
  if (maxResults > MAX_PAGE_SIZE) {
    throw new ArxivValidationError(
      `maxResults must not exceed ${MAX_PAGE_SIZE}`,
    );
  }
  if (start + maxResults > MAX_RESULT_WINDOW) {
    throw new ArxivValidationError(
      `start + maxResults must not exceed arXiv's ${MAX_RESULT_WINDOW} result window`,
    );
  }
  if (options.timeoutMs !== undefined)
    assertPositiveInteger(options.timeoutMs, "timeoutMs");
  if (options.ids !== undefined && !Array.isArray(options.ids)) {
    throw new ArxivValidationError("ids must be an array");
  }
  if (
    options.sortBy !== undefined &&
    !["relevance", "lastUpdatedDate", "submittedDate"].includes(options.sortBy)
  ) {
    throw new ArxivValidationError("sortBy is invalid");
  }
  if (
    options.sortOrder !== undefined &&
    !["ascending", "descending"].includes(options.sortOrder)
  ) {
    throw new ArxivValidationError("sortOrder is invalid");
  }
  if (
    options.query === undefined &&
    (!options.ids || options.ids.length === 0)
  ) {
    throw new ArxivValidationError(
      "Provide a query, at least one arXiv ID, or both",
    );
  }
  return { start, maxResults };
}

/** A stateless arXiv API client. Request throttling is shared by requests on this instance. */
export class ArxivClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #retry: ResolvedRetryOptions;
  readonly #transport: ArxivTransport;
  readonly #interval: RequestInterval;

  constructor(options: ArxivClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? options.baseURL ?? DEFAULT_BASE_URL;
    try {
      const baseUrl = new URL(this.#baseUrl);
      if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
        throw new Error("Only HTTP(S) base URLs are supported");
      }
    } catch (cause) {
      throw new ArxivValidationError(`Invalid base URL: ${this.#baseUrl}`, {
        cause,
      });
    }
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    assertPositiveInteger(this.#timeoutMs, "timeoutMs");
    if (options.maxResponseBytes !== undefined) {
      assertPositiveInteger(options.maxResponseBytes, "maxResponseBytes");
    }
    this.#retry = resolveRetryOptions(options.retry);

    const minIntervalMs =
      options.rateLimit === false
        ? 0
        : (options.rateLimit?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
    assertNonNegativeInteger(minIntervalMs, "rateLimit.minIntervalMs");
    this.#interval = new RequestInterval(minIntervalMs);
    this.#transport =
      options.transport ??
      new FetchTransport({
        fetch: options.fetch,
        headers: options.headers,
        maxResponseBytes: options.maxResponseBytes,
      });
  }

  buildUrl(options: ArxivSearchOptions): string {
    const { start, maxResults } = validateSearchOptions(options);
    const query = normalizeQuery(options.query);
    const ids = options.ids?.map(normalizeArxivId) ?? [];
    const url = new URL(this.#baseUrl);
    if (query) url.searchParams.set("search_query", query);
    if (ids.length > 0) url.searchParams.set("id_list", ids.join(","));
    url.searchParams.set("start", String(start));
    url.searchParams.set("max_results", String(maxResults));
    if (options.sortBy) url.searchParams.set("sortBy", options.sortBy);
    if (options.sortOrder) url.searchParams.set("sortOrder", options.sortOrder);
    const value = url.toString();
    if (value.length > MAX_URL_LENGTH) {
      throw new ArxivValidationError(
        `Request URL exceeds ${MAX_URL_LENGTH} characters; split IDs or simplify the query`,
      );
    }
    return value;
  }

  search(options: ArxivSearchOptions): Promise<ArxivSearchResult> {
    const { start } = validateSearchOptions(options);
    const query = normalizeQuery(options.query);
    const url = this.buildUrl(options);
    return this.#search(url, query, start, options);
  }

  async #search(
    url: string,
    query: string | undefined,
    start: number,
    options: ArxivSearchOptions,
  ): Promise<ArxivSearchResult> {
    const response = await this.#request(
      url,
      options.signal,
      options.timeoutMs ?? this.#timeoutMs,
    );

    try {
      return parseArxivFeed(response.body, {
        url,
        query,
        fallbackStart: start,
      });
    } catch (cause) {
      throw new ArxivParseError(
        `Failed to parse the arXiv response from ${url}`,
        {
          url,
          cause,
        },
      );
    }
  }

  query(...queries: QueryInput[]): ArxivRequest {
    return new ArxivRequest(this, { query: queryFrom(queries) });
  }

  ids(ids: readonly string[]): ArxivRequest {
    return new ArxivRequest(this, { ids: [...ids] });
  }

  async getById(
    id: string,
    options: Omit<
      ArxivSearchOptions,
      "ids" | "query" | "start" | "maxResults"
    > = {},
  ): Promise<ArxivEntry | null> {
    const result = await this.search({
      ...options,
      ids: [normalizeArxivId(id)],
      maxResults: 1,
    });
    return result.entries[0] ?? null;
  }

  async getByIds(
    ids: readonly string[],
    options: Omit<
      ArxivSearchOptions,
      "ids" | "query" | "start" | "maxResults"
    > = {},
  ): Promise<ArxivIdLookupResult> {
    if (ids.length === 0)
      throw new ArxivValidationError("getByIds() requires at least one ID");
    if (ids.length > MAX_PAGE_SIZE) {
      throw new ArxivValidationError(
        `getByIds() accepts at most ${MAX_PAGE_SIZE} IDs`,
      );
    }
    const requestedIds = ids.map(normalizeArxivId);
    const result = await this.search({
      ...options,
      ids: requestedIds,
      maxResults: requestedIds.length,
    });
    return {
      ...result,
      requestedIds,
      missingIds: requestedIds.filter((id) => !wasReturned(id, result.entries)),
    };
  }

  async *pages(
    options: ArxivPaginationOptions,
  ): AsyncGenerator<ArxivSearchResult, void, undefined> {
    const pageSize = options.pageSize ?? 100;
    const start = options.start ?? 0;
    const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
    const maxItems = options.maxItems ?? Number.POSITIVE_INFINITY;
    assertPositiveInteger(pageSize, "pageSize");
    if (pageSize > MAX_PAGE_SIZE) {
      throw new ArxivValidationError(
        `pageSize must not exceed ${MAX_PAGE_SIZE}`,
      );
    }
    assertNonNegativeInteger(start, "start");
    if (start >= MAX_RESULT_WINDOW) {
      throw new ArxivValidationError(
        `start must be less than ${MAX_RESULT_WINDOW}`,
      );
    }
    if (maxPages !== Number.POSITIVE_INFINITY)
      assertNonNegativeInteger(maxPages, "maxPages");
    if (maxItems !== Number.POSITIVE_INFINITY)
      assertNonNegativeInteger(maxItems, "maxItems");

    let nextStart = start;
    let pages = 0;
    let items = 0;
    while (
      pages < maxPages &&
      items < maxItems &&
      nextStart < MAX_RESULT_WINDOW
    ) {
      const requestedSize = Math.min(
        pageSize,
        maxItems - items,
        MAX_RESULT_WINDOW - nextStart,
      );
      const page = await this.search({
        ...options,
        start: nextStart,
        maxResults: requestedSize,
      });
      pages += 1;
      items += page.entries.length;
      yield page;

      if (page.entries.length === 0 || items >= maxItems) return;
      const consumed = Math.max(page.itemsPerPage, page.entries.length);
      const candidate = page.startIndex + consumed;
      if (candidate <= nextStart || candidate >= page.totalResults) return;
      nextStart = candidate;
    }
  }

  async *iterate(
    options: ArxivPaginationOptions,
  ): AsyncGenerator<ArxivEntry, void, undefined> {
    let emitted = 0;
    const maxItems = options.maxItems ?? Number.POSITIVE_INFINITY;
    for await (const page of this.pages(options)) {
      for (const entry of page.entries) {
        if (emitted >= maxItems) return;
        emitted += 1;
        yield entry;
      }
    }
  }

  async #request(
    url: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ) {
    let attempt = 0;
    while (attempt <= this.#retry.retries) {
      attempt += 1;
      try {
        await this.#interval.wait(signal);
        const response = await this.#transport.get(url, { signal, timeoutMs });
        if (response.status >= 200 && response.status < 300) return response;

        const retryAfterMs = parseRetryAfter(
          response.headers.get("retry-after"),
          this.#retry.maxDelayMs,
        );
        if (
          this.#retry.statuses.has(response.status) &&
          attempt <= this.#retry.retries
        ) {
          await delay(retryAfterMs ?? retryDelay(this.#retry, attempt), signal);
          continue;
        }
        const bodyTruncated = response.body.length > MAX_ERROR_BODY_LENGTH;
        throw new ArxivApiError(
          `arXiv API returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
          {
            status: response.status,
            statusText: response.statusText,
            url,
            body: bodyTruncated
              ? response.body.slice(0, MAX_ERROR_BODY_LENGTH)
              : response.body,
            bodyTruncated,
            retryAfterMs,
            attempts: attempt,
          },
        );
      } catch (cause) {
        if (cause instanceof ArxivApiError) throw cause;
        if (signal?.aborted) {
          throw new ArxivNetworkError("The arXiv request was aborted", {
            url,
            attempts: attempt,
            aborted: true,
            cause,
          });
        }
        if (cause instanceof ArxivResponseTooLargeError) {
          throw new ArxivNetworkError(
            "The arXiv response exceeded the safety limit",
            {
              url,
              attempts: attempt,
              cause,
            },
          );
        }
        if (attempt <= this.#retry.retries) {
          try {
            await delay(retryDelay(this.#retry, attempt), signal);
          } catch (abortCause) {
            throw new ArxivNetworkError("The arXiv request was aborted", {
              url,
              attempts: attempt,
              aborted: true,
              cause: abortCause,
            });
          }
          continue;
        }
        throw new ArxivNetworkError(
          `Failed to request the arXiv API at ${url}`,
          {
            url,
            attempts: attempt,
            timedOut: cause instanceof ArxivTransportTimeoutError,
            cause,
          },
        );
      }
    }

    throw new ArxivNetworkError(`Failed to request the arXiv API at ${url}`, {
      url,
      attempts: attempt,
    });
  }
}

/** Immutable compatibility builder. Every method returns a new request. */
export class ArxivRequest {
  readonly #client: ArxivClient;
  readonly #state: RequestState;

  constructor(client: ArxivClient, state: Partial<RequestState> = {}) {
    this.#client = client;
    this.#state = {
      start: 0,
      maxResults: 10,
      ...state,
      ids: state.ids ? [...state.ids] : undefined,
    };
  }

  #with(patch: Partial<RequestState>): ArxivRequest {
    return new ArxivRequest(this.#client, { ...this.#state, ...patch });
  }

  query(...queries: QueryInput[]): ArxivRequest {
    return this.#with({ query: queryFrom(queries) });
  }

  ids(ids: readonly string[]): ArxivRequest {
    return this.#with({ ids: [...ids] });
  }

  start(start: number): ArxivRequest {
    return this.#with({ start });
  }

  maxResults(maxResults: number): ArxivRequest {
    return this.#with({ maxResults });
  }

  sortBy(sortBy: SortBy): ArxivRequest {
    return this.#with({ sortBy });
  }

  sortOrder(sortOrder: SortOrder): ArxivRequest {
    return this.#with({ sortOrder });
  }

  signal(signal: AbortSignal): ArxivRequest {
    return this.#with({ signal });
  }

  timeout(timeoutMs: number): ArxivRequest {
    return this.#with({ timeoutMs });
  }

  get url(): string {
    return this.#client.buildUrl(this.#state);
  }

  execute(): Promise<ArxivEntry[]> {
    return this.executeWithMetadata().then((result) => result.entries);
  }

  executeWithMetadata(): Promise<ArxivSearchResult> {
    return this.#client.search(this.#state);
  }

  iterate(
    options: ArxivIterationOptions = {},
  ): AsyncGenerator<ArxivEntry, void, undefined> {
    return this.#client.iterate({
      ...this.#state,
      pageSize: options.pageSize ?? this.#state.maxResults,
      maxPages: options.maxPages,
      maxItems: options.maxItems,
      signal: options.signal ?? this.#state.signal,
    });
  }
}

export function createArxivClient(
  options: ArxivClientOptions = {},
): ArxivClient {
  return new ArxivClient(options);
}

export const arxivClient = createArxivClient();

export {
  ArxivApiError,
  ArxivNetworkError,
  ArxivParseError,
  ArxivValidationError,
} from "./errors";
