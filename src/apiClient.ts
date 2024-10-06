import { parseStringPromise } from 'xml2js';

interface ArxivClientOptions {
    baseURL?: string;
}

class ArxivClient {
    private baseURL: string;

    constructor(options?: ArxivClientOptions) {
        this.baseURL = options?.baseURL || 'http://export.arxiv.org/api/query';
    }

    public async query(queryString: string, start: number = 0, maxResults: number = 10, sortBy?: string, sortOrder?: 'ascending' | 'descending') {
        const params = new URLSearchParams({
            search_query: queryString,
            start: start.toString(),
            max_results: maxResults.toString(),
        });

        if (sortBy) {
            params.append('sortBy', sortBy);
        }
        if (sortOrder) {
            params.append('sortOrder', sortOrder);
        }

        const url = `${this.baseURL}?${params.toString()}`;

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }
            const responseData = await response.text();
            const data = await parseStringPromise(responseData, { explicitArray: false });
            return data.feed.entry ? this.normalizeResponse(data.feed.entry) : [];
        } catch (error) {
            throw new Error(`Error fetching data from arXiv API: ${error}`);
        }
    }

    public async getByIdList(idList: string[], start: number = 0, maxResults: number = 10) {
        const params = new URLSearchParams({
            id_list: idList.join(','),
            start: start.toString(),
            max_results: maxResults.toString(),
        });

        const url = `${this.baseURL}?${params.toString()}`;

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }
            const responseData = await response.text();
            const data = await parseStringPromise(responseData, { explicitArray: false });
            return data.feed.entry ? this.normalizeResponse(data.feed.entry) : [];
        } catch (error) {
            throw new Error(`Error fetching data from arXiv API: ${error}`);
        }
    }

    private normalizeResponse(entries: any | any[]): any[] {
        if (!Array.isArray(entries)) {
            entries = [entries];
        }

        return entries.map((entry: any) => ({
            id: entry.id,
            title: entry.title,
            summary: entry.summary,
            authors: entry.author instanceof Array ? entry.author.map((a: any) => a.name) : [entry.author.name],
            published: entry.published,
            updated: entry.updated,
            link: entry.link instanceof Array ? entry.link.find((l: any) => l.rel === 'alternate').href : entry.link.href,
            categories: entry.category instanceof Array ? entry.category.map((c: any) => c.term) : [entry.category.term],
            primaryCategory: entry['arxiv:primary_category']?.term,
            journalRef: entry['arxiv:journal_ref'] || null,
            doi: entry['arxiv:doi'] || null,
            comment: entry['arxiv:comment'] || null,
        }));
    }
}

export const arxivClient = new ArxivClient();