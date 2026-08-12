import type { Query, QueryField } from "./types";

const FIELD_PREFIX = {
  title: "ti",
  author: "au",
  abstract: "abs",
  comment: "co",
  journalReference: "jr",
  category: "cat",
  reportNumber: "rn",
  all: "all",
} as const satisfies Record<QueryField, string>;

const quote = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Render a query AST in arXiv API syntax. No URL encoding is performed here. */
export function serializeQuery(query: Query): string {
  switch (query.kind) {
    case "term":
      return `${FIELD_PREFIX[query.field]}:${quote(query.value)}`;
    case "range":
      return `submittedDate:[${query.from} TO ${query.to}]`;
    case "raw":
      return query.value;
    case "not":
      throw new Error(
        "not() must be used as a child of and()/andNot(); standalone NOT is invalid",
      );
    case "and":
      return joinLogical(query.queries, "AND");
    case "or":
      if (query.queries.some(containsNot)) {
        throw new Error("NOT is not allowed inside OR");
      }
      return joinLogical(query.queries, "OR");
  }
}

function containsNot(query: Query): boolean {
  if (query.kind === "not") return true;
  if (query.kind === "and" || query.kind === "or")
    return query.queries.some(containsNot);
  return false;
}

function joinLogical(
  queries: readonly Query[],
  operator: "AND" | "OR",
): string {
  if (queries.length === 0)
    throw new Error(`${operator.toLowerCase()}() requires at least one query`);
  let output = `(${serializeQuery(queries[0])}`;
  for (const child of queries.slice(1)) {
    if (child.kind === "not") {
      if (operator !== "AND") throw new Error("NOT is not allowed inside OR");
      output += ` ANDNOT ${serializeQuery(child.query)}`;
    } else {
      output += ` ${operator} ${serializeQuery(child)}`;
    }
  }
  return `${output})`;
}
