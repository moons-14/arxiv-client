# Arxiv Client
A TypeScript client library for interacting with the arXiv API

## Installation
```bash
npm install arxiv-client
```

## Usage

Example usage:
```typescript
import arxivClient, { and, title, category } from "arxiv-client";

const articles = await arxivClient.query(and(category("quant-ph"), title("ai")))
    .start(0)
    .maxResults(10)
    .sortBy('lastUpdatedDate')
    .sortOrder('ascending')
    .execute();
```