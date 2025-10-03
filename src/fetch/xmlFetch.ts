import { XMLBuilder, XMLParser } from 'fast-xml-parser';

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    numberParseOptions: {
        leadingZeros: false,
        hex: false,
    },
});

const xmlBuilder = new XMLBuilder({
    ignoreAttributes: false,
    format: true,
});

async function get(url: string, data?: unknown) {
    const body = data ? xmlBuilder.build(data).toString() : undefined;

    const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'text/xml' },
        body,
    });

    const text = await response.text();
    const parsed = xmlParser.parse(text);

    return { status: response.status, data: parsed };
}

const xmlFetch = { get };

export default xmlFetch;

