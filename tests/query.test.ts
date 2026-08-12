import { describe, expect, it } from "vitest";
import {
  all,
  and,
  andNot,
  author,
  category,
  not,
  or,
  raw,
  serializeQuery,
  submittedDate,
  title,
} from "../src/query";

describe("query AST builders and serializer", () => {
  it("serializes terms and logical expressions in arXiv syntax", () => {
    expect(serializeQuery(title("transformers"))).toBe('ti:"transformers"');
    expect(serializeQuery(author("Jane Doe"))).toBe('au:"Jane Doe"');
    expect(serializeQuery(category("cs.AI"))).toBe('cat:"cs.AI"');
    expect(serializeQuery(and(title("transformers"), author("Jane Doe")))).toBe(
      '(ti:"transformers" AND au:"Jane Doe")',
    );
    expect(serializeQuery(or(title("vision"), title("image")))).toBe(
      '(ti:"vision" OR ti:"image")',
    );
  });

  it("renders ANDNOT as a first-class exclusion", () => {
    expect(serializeQuery(andNot(category("cs.AI"), title("survey")))).toBe(
      '(cat:"cs.AI" ANDNOT ti:"survey")',
    );
    expect(serializeQuery(and(title("model"), not(author("anonymous"))))).toBe(
      '(ti:"model" ANDNOT au:"anonymous")',
    );
  });

  it("escapes quotes and backslashes without URL encoding", () => {
    expect(serializeQuery(title('a "quoted" \\ path'))).toBe(
      'ti:"a \\"quoted\\" \\\\ path"',
    );
    expect(serializeQuery(raw("ti:%25 AND au:foo%20bar"))).toBe(
      "ti:%25 AND au:foo%20bar",
    );
    // serializeQuery is deliberately pre-URL-encoding: percent escapes survive exactly once.
    expect(serializeQuery(all("C++ & R&D"))).toBe('all:"C++ & R&D"');
  });

  it("normalizes date ranges from legacy dates and UTC Dates", () => {
    expect(serializeQuery(submittedDate("20240102", "20240103"))).toBe(
      "submittedDate:[202401020000 TO 202401032359]",
    );
    expect(serializeQuery(submittedDate("202401020930", "202401031015"))).toBe(
      "submittedDate:[202401020930 TO 202401031015]",
    );
    expect(
      serializeQuery(
        submittedDate(
          new Date("2024-01-02T03:04:00.000Z"),
          new Date("2024-01-03T05:06:00.000Z"),
        ),
      ),
    ).toBe("submittedDate:[202401020304 TO 202401030506]");
  });

  it("rejects invalid or unsupported query shapes", () => {
    expect(() => title("   ")).toThrow(/must not be empty/);
    expect(() => and()).toThrow(/at least one/);
    expect(() => or()).toThrow(/at least one/);
    expect(() => or(title("ok"), not(author("no")))).toThrow(/NOT.*OR/);
    expect(() => not(not(title("nested")))).toThrow(/nested NOT/);
    expect(() => serializeQuery(not(title("standalone")))).toThrow(
      /standalone NOT/,
    );
    expect(() => submittedDate("20240230", "20240301")).toThrow(
      /invalid submittedDate/,
    );
    expect(() => submittedDate("20240102", "20240101")).toThrow(
      /start must not be after/,
    );
    expect(() => submittedDate("2024-01-01", "20240102")).toThrow(
      /YYYYMMDDHHmm/,
    );
  });
});
