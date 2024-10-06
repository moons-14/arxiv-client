import axios from 'axios';
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

const xmlAxios = axios.create({
    responseType: 'document',
    headers: { 'Content-Type': 'text/xml' },
    transformRequest: [
        (data) => {
            const xml = xmlBuilder.build(data);
            return xml.toString();
        },
    ],
    transformResponse: [
        (data) => {
            const obj = xmlParser.parse(data);
            return obj;
        },
    ],
});

export default xmlAxios;