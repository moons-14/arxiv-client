import { describe, expect, it } from "vitest";
import { FetchTransport } from "../src/transport/fetchTransport";
import {
  ArxivResponseTooLargeError,
  ArxivTransportTimeoutError,
} from "../src/transport/types";

const requestOptions = (timeoutMs = 1000, signal?: AbortSignal) => ({
  timeoutMs,
  ...(signal ? { signal } : {}),
});

describe("FetchTransport", () => {
  it("sends GET, the default Accept header, and custom headers", async () => {
    let receivedUrl = "";
    let receivedInit: RequestInit | undefined;
    const transport = new FetchTransport({
      headers: { Authorization: "Bearer test", "X-Client": "test" },
      fetch: async (input, init) => {
        receivedUrl = String(input);
        receivedInit = init;
        return new Response("<feed />", { status: 200 });
      },
    });

    await transport.get("https://example.test/api", requestOptions());

    expect(receivedUrl).toBe("https://example.test/api");
    expect(receivedInit?.method).toBe("GET");
    expect(receivedInit?.headers).toEqual({
      Accept: "application/atom+xml, application/xml;q=0.9",
      Authorization: "Bearer test",
      "X-Client": "test",
    });
    expect(receivedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns status, status text, headers, and the decoded body", async () => {
    const transport = new FetchTransport({
      fetch: async () =>
        new Response("hello", {
          status: 201,
          statusText: "Created",
          headers: { "X-Trace": "abc123" },
        }),
    });

    const result = await transport.get(
      "https://example.test",
      requestOptions(),
    );

    expect(result.status).toBe(201);
    expect(result.statusText).toBe("Created");
    expect(result.headers.get("x-trace")).toBe("abc123");
    expect(result.body).toBe("hello");
  });

  it("propagates an external abort signal and its reason", async () => {
    const reason = new Error("caller cancelled");
    let passedSignal: AbortSignal | undefined;
    const transport = new FetchTransport({
      fetch: (_input, init) => {
        passedSignal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          passedSignal?.addEventListener(
            "abort",
            () => reject(passedSignal?.reason),
            { once: true },
          );
        });
      },
    });
    const controller = new AbortController();
    const request = transport.get(
      "https://example.test",
      requestOptions(1000, controller.signal),
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(passedSignal?.aborted).toBe(true);
    expect(passedSignal?.reason).toBe(reason);
  });

  it("converts a timeout abort into ArxivTransportTimeoutError", async () => {
    const transport = new FetchTransport({
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    });

    const request = transport.get("https://example.test", requestOptions(5));
    await expect(request).rejects.toMatchObject({
      name: "ArxivTransportTimeoutError",
      timeoutMs: 5,
    });
    await expect(request).rejects.toBeInstanceOf(ArxivTransportTimeoutError);
  });

  it("rejects a response whose content-length exceeds the byte limit", async () => {
    const transport = new FetchTransport({
      maxResponseBytes: 4,
      fetch: async () =>
        new Response("ok", { headers: { "content-length": "5" } }),
    });

    await expect(
      transport.get("https://example.test", requestOptions()),
    ).rejects.toMatchObject({
      name: "ArxivResponseTooLargeError",
      maxResponseBytes: 4,
    });
  });

  it("enforces the byte limit while reading a chunked stream and cancels it", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abc"));
        controller.enqueue(new TextEncoder().encode("de"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const transport = new FetchTransport({
      maxResponseBytes: 4,
      fetch: async () => new Response(stream),
    });

    await expect(
      transport.get("https://example.test", requestOptions()),
    ).rejects.toBeInstanceOf(ArxivResponseTooLargeError);
    expect(cancelled).toBe(true);
  });

  it("requires maxResponseBytes to be a positive safe integer", () => {
    for (const maxResponseBytes of [0, -1, 1.5, Number.NaN, Infinity]) {
      expect(() => new FetchTransport({ maxResponseBytes })).toThrow(
        "maxResponseBytes must be a positive integer",
      );
    }
  });

  it("returns an empty body when the response has no body", async () => {
    const transport = new FetchTransport({
      fetch: async () => new Response(null, { status: 204 }),
    });

    const result = await transport.get(
      "https://example.test",
      requestOptions(),
    );
    expect(result.status).toBe(204);
    expect(result.body).toBe("");
  });
});
