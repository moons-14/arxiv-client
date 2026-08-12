export type ArxivErrorCode =
  | "ARXIV_API_ERROR"
  | "ARXIV_NETWORK_ERROR"
  | "ARXIV_PARSE_ERROR"
  | "ARXIV_VALIDATION_ERROR";

export class ArxivError extends Error {
  readonly code: ArxivErrorCode;

  constructor(message: string, code: ArxivErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ArxivValidationError extends ArxivError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "ARXIV_VALIDATION_ERROR", options);
  }
}

export interface ArxivApiErrorOptions extends ErrorOptions {
  status: number;
  statusText?: string;
  url: string;
  body?: string;
  bodyTruncated?: boolean;
  retryAfterMs?: number;
  attempts: number;
}

export class ArxivApiError extends ArxivError {
  readonly status: number;
  readonly statusText?: string;
  readonly url: string;
  readonly body?: string;
  readonly bodyTruncated: boolean;
  readonly retryAfterMs?: number;
  readonly attempts: number;

  constructor(message: string, options: ArxivApiErrorOptions) {
    super(message, "ARXIV_API_ERROR", options);
    this.status = options.status;
    this.statusText = options.statusText;
    this.url = options.url;
    this.body = options.body;
    this.bodyTruncated = options.bodyTruncated ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.attempts = options.attempts;
  }
}

export interface ArxivNetworkErrorOptions extends ErrorOptions {
  url: string;
  attempts: number;
  aborted?: boolean;
  timedOut?: boolean;
}

export class ArxivNetworkError extends ArxivError {
  readonly url: string;
  readonly attempts: number;
  readonly aborted: boolean;
  readonly timedOut: boolean;

  constructor(message: string, options: ArxivNetworkErrorOptions) {
    super(message, "ARXIV_NETWORK_ERROR", options);
    this.url = options.url;
    this.attempts = options.attempts;
    this.aborted = options.aborted ?? false;
    this.timedOut = options.timedOut ?? false;
  }
}

export interface ArxivParseErrorOptions extends ErrorOptions {
  url: string;
}

export class ArxivParseError extends ArxivError {
  readonly url: string;

  constructor(message: string, options: ArxivParseErrorOptions) {
    super(message, "ARXIV_PARSE_ERROR", options);
    this.url = options.url;
  }
}
