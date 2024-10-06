import type { Category } from './defines/categories';
import { parseStringPromise } from 'xml2js';
import xmlAxios from './fetch/axios';


interface ArxivClientOptions {
    baseURL?: string;
}

export type ArxivEntry = {
    id: string; // 9999999v9
    title: string; // "Title of the paper"
    updated: Date; // UTC?
    published: Date; // UTC?
    summary: string; // "Summary of the paper"
    authors: {
        name: string; // "Author 1"
        affiliation?: string; // "Affiliation 1"
    }[];
    categories: Category[];
    primaryCategory?: Category;
    links: {
        href: string; // "https://arxiv.org/abs/9999999v9"
        rel: "alternate" | "related";
        type: "text/html" | "application/pdf";
    }[], // not include doi link
    doi?: {
        id: string; // "10.9999/99999999"
        url: string; // "https://doi.org/10.9999/99999999"
    },
    comment?: string; // "Comment on the paper"
    journalRef?: string; // "Journal reference"
}

class ArxivClient {
    private baseURL: string;
    private queryString: string = '';
    private idList: string[] = [];
    private startValue: number = 0;
    private maxResultsValue: number = 10;
    private sortByValue?: string;
    private sortOrderValue?: 'ascending' | 'descending';

    constructor(options?: ArxivClientOptions) {
        this.baseURL = options?.baseURL || 'http://export.arxiv.org/api/query';
    }

    public query(queryString: string, idList: string[] = []): this {
        this.queryString = queryString;
        this.idList = idList;
        return this;
    }

    public start(start: number): this {
        this.startValue = start;
        return this;
    }

    public maxResults(maxResults: number): this {
        this.maxResultsValue = maxResults;
        return this;
    }

    public sortBy(sortBy: "relevance" | "lastUpdatedDate" | "submittedDate"): this {
        this.sortByValue = sortBy;
        return this;
    }

    public sortOrder(sortOrder: 'ascending' | 'descending'): this {
        this.sortOrderValue = sortOrder;
        return this;
    }

    public async execute() {
        const params = new URLSearchParams({
            search_query: this.queryString,
            start: this.startValue.toString(),
            max_results: this.maxResultsValue.toString(),
        });

        if (this.idList.length > 0) {
            params.append('id_list', this.idList.join(','));
        }

        if (this.sortByValue) {
            params.append('sortBy', this.sortByValue);
        }
        if (this.sortOrderValue) {
            params.append('sortOrder', this.sortOrderValue);
        }

        const url = `${this.baseURL}?${params.toString()}`;

        const response = await xmlAxios.get(url);
        const responseData = await response.data;
        if (response.status !== 200) {
            throw new Error(`Error fetching data from arXiv API`);
        }

        return responseData.feed.entry ? this.normalizeResponse(responseData.feed.entry) : [];

    }

    private normalizeResponse(entries: any | any[]): ArxivEntry[] {
        if (!Array.isArray(entries)) {
            entries = [entries];
        }

        return entries.map((entry: any) => ({
            id: entry.id,
            title: entry.title,
            updated: new Date(entry.updated),
            published: new Date(entry.published),
            summary: entry.summary,
            authors: entry.author instanceof Array ? entry.author.map((a: any) => (a["arxiv:affiliation"] ? { name: a.name, affiliation: a["arxiv:affiliation"]["#text"] } : { name: a.name })) : [entry.author["arxiv:affiliation"] ? { name: entry.author.name, affiliation: entry.author["arxiv:affiliation"]["#text"] } : { name: entry.author.name }],
            categories: entry.category instanceof Array ? entry.category.map((c: any) => c["@_term"]) : [entry.category["@_term"]],
            primaryCategory: entry["arxiv:primary_category"] ? entry["arxiv:primary_category"]["@_term"] : undefined,
            links: entry.link.filter((l: any) => !(l["@_title"] && l["@_title"] == "doi")).map((l: any) => ({ href: l["@_href"], rel: l["@_rel"], type: l["@_type"] })),
            doi: entry["arxiv:doi"] ? { id: entry["arxiv:doi"]["#text"], url: entry.link.find((l: any) => l["@_title"] && l["@_title"] == "doi")["@_href"] } : undefined,
            comment: entry["arxiv:comment"] ? entry["arxiv:comment"]["#text"] : undefined,
            journalRef: entry["arxiv:journal_ref"] ? entry["arxiv:journal_ref"]["#text"] : undefined,
        } as ArxivEntry));
    }
}

export const arxivClient = new ArxivClient();