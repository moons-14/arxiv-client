import arxivClient, { abstract, and, author, not, or, title, category } from "./src/index";

async function exampleUsage() {
    try {

        const articles = await arxivClient.query(and(category("quant-ph"), title("")))
            .start(0)
            .maxResults(10)
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