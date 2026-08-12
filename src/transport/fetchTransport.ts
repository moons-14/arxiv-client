import type {
  ArxivFetch,
  ArxivTransport,
  ArxivTransportRequestOptions,
  ArxivTransportResponse,
} from "./types";
import {
  ArxivResponseTooLargeError,
  ArxivTransportTimeoutError,
} from "./types";

const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface FetchTransportOptions {
  fetch?: ArxivFetch;
  headers?: Readonly<Record<string, string>>;
  maxResponseBytes?: number;
}

function createSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void; didTimeout: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal?.aborted) {
    abortFromExternal();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternal, {
      once: true,
    });
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new ArxivTransportTimeoutError(timeoutMs));
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
    didTimeout: () => timedOut,
  };
}

async function readBody(
  response: Response,
  maxResponseBytes: number,
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    throw new ArxivResponseTooLargeError(maxResponseBytes);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxResponseBytes) {
        await reader.cancel();
        throw new ArxivResponseTooLargeError(maxResponseBytes);
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export class FetchTransport implements ArxivTransport {
  readonly #fetch: ArxivFetch;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #maxResponseBytes: number;

  constructor(options: FetchTransportOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#headers = options.headers ?? {};
    this.#maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (
      !Number.isSafeInteger(this.#maxResponseBytes) ||
      this.#maxResponseBytes <= 0
    ) {
      throw new TypeError("maxResponseBytes must be a positive integer");
    }
  }

  async get(
    url: string,
    options: ArxivTransportRequestOptions,
  ): Promise<ArxivTransportResponse> {
    const { signal, cleanup, didTimeout } = createSignal(
      options.timeoutMs,
      options.signal,
    );

    try {
      const response = await this.#fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/atom+xml, application/xml;q=0.9",
          ...this.#headers,
        },
        signal,
      });

      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: await readBody(response, this.#maxResponseBytes),
      };
    } catch (cause) {
      if (didTimeout()) {
        throw new ArxivTransportTimeoutError(options.timeoutMs, { cause });
      }
      throw cause;
    } finally {
      cleanup();
    }
  }
}
