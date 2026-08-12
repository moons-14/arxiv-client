import assert from "node:assert/strict";
import { createRequire } from "node:module";

const esm = await import(new URL("../dist/index.js", import.meta.url));
const require = createRequire(import.meta.url);
const cjs = require("../dist/index.cjs");

for (const module of [esm, cjs]) {
  assert.equal(typeof module.ArxivClient, "function");
  assert.equal(typeof module.parseArxivFeed, "function");
  assert.equal(typeof module.default.query, "function");
  assert.equal(
    module.serializeQuery(
      module.and(module.category("cs.AI"), module.title("agents")),
    ),
    '(cat:"cs.AI" AND ti:"agents")',
  );
}

console.log("Verified ESM and CommonJS package entry points.");
