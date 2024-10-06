# Arxiv Client
A TypeScript client library for interacting with the arXiv API

## Installation
```bash
npm install arxiv-client
```

## Usage

Example usage:
```typescript
import arxivClient, { abstract, and, not, or, title, category } from "arxiv-client";

const articles = await arxivClient.query(
    and(category("cs.AI"), title("game"), abstract("reinforcement learning")),
    not(or(title("deep"), title("Human"))),
)
    .start(0)
    .maxResults(20)
    .sortBy('lastUpdatedDate')
    .sortOrder('ascending')
    .execute();
console.dir(articles, {
    depth: null
});
```