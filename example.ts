import { ArxivClient, abstract, and, category, title } from "./src/index";

const client = new ArxivClient();

async function main(): Promise<void> {
  const result = await client.search({
    query: and(
      category("cs.AI"),
      title("reinforcement learning"),
      abstract("robotics"),
    ),
    maxResults: 3,
    sortBy: "lastUpdatedDate",
    sortOrder: "descending",
  });

  console.log({
    returned: result.entries.length,
    totalResults: result.totalResults,
    url: result.url,
  });

  for (const entry of result.entries) {
    console.log(`${entry.arxivId}: ${entry.title}`);
  }
}

main().catch((error: unknown) => {
  console.error("arXiv request failed", error);
});
