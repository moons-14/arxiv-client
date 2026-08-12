import type { Category } from "../defines/categories";

/** The small, serializable AST used to build arXiv search queries. */
export type Query =
  | {
      readonly kind: "term";
      readonly field: QueryField;
      readonly value: string;
    }
  | {
      readonly kind: "range";
      readonly field: "submittedDate";
      readonly from: string;
      readonly to: string;
    }
  | { readonly kind: "and"; readonly queries: readonly Query[] }
  | { readonly kind: "or"; readonly queries: readonly Query[] }
  | { readonly kind: "not"; readonly query: Query }
  | { readonly kind: "raw"; readonly value: string };

export type QueryField =
  | "title"
  | "author"
  | "abstract"
  | "comment"
  | "journalReference"
  | "category"
  | "reportNumber"
  | "all";

export type QueryCategory = Category;
