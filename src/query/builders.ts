import type { Category } from "../defines/categories";
import type { Query, QueryField } from "./types";

const term = (field: QueryField, value: string): Query => {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${field} term must not be empty`);
  return { kind: "term", field, value };
};

export const title = (value: string): Query => term("title", value);
export const author = (value: string): Query => term("author", value);
export const abstract = (value: string): Query => term("abstract", value);
export const comment = (value: string): Query => term("comment", value);
export const journalReference = (value: string): Query =>
  term("journalReference", value);
export const category = (value: Category): Query => term("category", value);
export const reportNumber = (value: string): Query =>
  term("reportNumber", value);
export const all = (value: string): Query => term("all", value);

export const and = (...queries: Query[]): Query => {
  if (queries.length === 0)
    throw new Error("and() requires at least one query");
  return { kind: "and", queries };
};

export const or = (...queries: Query[]): Query => {
  if (queries.length === 0) throw new Error("or() requires at least one query");
  if (queries.some(containsNot))
    throw new Error("NOT is not allowed inside OR");
  return { kind: "or", queries };
};

function containsNot(query: Query): boolean {
  if (query.kind === "not") return true;
  return (
    (query.kind === "and" || query.kind === "or") &&
    query.queries.some(containsNot)
  );
}

export const not = (query: Query): Query => {
  if (query.kind === "not") throw new Error("nested NOT is invalid");
  return { kind: "not", query };
};

export const andNot = (include: Query, exclude: Query): Query =>
  and(include, not(exclude));
export const raw = (value: string): Query => {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error("raw query must not be empty");
  return { kind: "raw", value };
};

const dateToken = (value: string | Date, end: boolean): string => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("invalid date");
    const p = (n: number) => String(n).padStart(2, "0");
    return `${String(value.getUTCFullYear()).padStart(4, "0")}${p(value.getUTCMonth() + 1)}${p(value.getUTCDate())}${p(value.getUTCHours())}${p(value.getUTCMinutes())}`;
  }
  if (!/^\d{8}(?:\d{4})?$/.test(value))
    throw new Error("submittedDate must be YYYYMMDDHHmm (or legacy YYYYMMDD)");
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hours = value.length === 12 ? Number(value.slice(8, 10)) : 0;
  const minutes = value.length === 12 ? Number(value.slice(10, 12)) : 0;
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > maxDay ||
    hours > 23 ||
    minutes > 59
  ) {
    throw new Error("invalid submittedDate timestamp");
  }
  return value.length === 8 ? `${value}${end ? "2359" : "0000"}` : value;
};

export function submittedDate(from: string, to: string): Query;
export function submittedDate(from: Date, to: Date): Query;
export function submittedDate(from: string | Date, to: string | Date): Query {
  const start = dateToken(from, false);
  const finish = dateToken(to, true);
  if (start > finish)
    throw new Error("submittedDate range start must not be after end");
  return { kind: "range", field: "submittedDate", from: start, to: finish };
}

export const submittedBetween = (from: Date, to: Date): Query =>
  submittedDate(from, to);
