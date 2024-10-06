import arxivClient, { abstract, and, author, not, or, title, category } from "./src/index";

async function exampleUsage() {
    try {

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
    } catch (error) {
        console.error('Error:', error);
    }
}

exampleUsage();