export interface ArxivResponseHeaders {
  get(name: string): string | null;
}

export interface ArxivTransportResponse {
  status: number;
  statusText: string;
  headers: ArxivResponseHeaders;
  body: string;
}

export interface ArxivTransportRequestOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface ArxivTransport {
  get(
    url: string,
    options: ArxivTransportRequestOptions,
  ): Promise<ArxivTransportResponse>;
}

export class ArxivTransportTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, options?: ErrorOptions) {
    super(`Request timed out after ${timeoutMs}ms`, options);
    this.name = "ArxivTransportTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class ArxivResponseTooLargeError extends Error {
  readonly maxResponseBytes: number;

  constructor(maxResponseBytes: number) {
    super(`Response exceeded the ${maxResponseBytes}-byte safety limit`);
    this.name = "ArxivResponseTooLargeError";
    this.maxResponseBytes = maxResponseBytes;
  }
}

export type ArxivFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
