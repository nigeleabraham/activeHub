const cheerio = require('cheerio');
const Facilities = require('../models/Facilities');

const LISTING_URL = 'https://camdenactive.camden.gov.uk/sports-centres-and-tennis-courts/';
const DRY_RUN = process.argv.includes('--dry-run');
const REQUEST_DELAY_MS = 300;
const FALLBACK_URLS = {
    'swiss-cottage': 'https://www.better.org.uk/leisure-centre/london/camden/swiss-cottage-leisure-centre/',
    'pancras-square': 'https://www.better.org.uk/leisure-centre/london/camden/pancras-square/',
    'kentish-town': 'https://www.better.org.uk/leisure-centre/london/camden/kentish-town-sports-centre/',
    oasis: 'https://www.better.org.uk/leisure-centre/london/camden/oasis-sports-centre/',
    armoury: 'https://www.armourygym.co.uk/contact/'
};
const NAME_OVERRIDES = {
    armoury: 'The Armoury'
};
const BOOKING_URL_OVERRIDES = {
    armoury: 'https://www.armourygym.co.uk/join-now/'
};
const COORDINATE_OVERRIDES = {
    'waterlow-park': { latitude: 51.56948339371256, longitude: -0.14707273568957463 }
};
const COORDINATE_OVERRIDES_BY_SOURCE = [
    {
        sourcePattern: /\/sports?\/kilburngrange\/?$/i,
        coordinates: { latitude: 51.54291789066829, longitude: -0.19758651774181468 }
    },
    {
        sourcePattern: /\/courses\/detail\/194\//i,
        coordinates: { latitude: 51.543946650872684, longitude: -0.1995966660824934 }
    }
];
const DESCRIPTION_OVERRIDES = [
    {
        sourcePattern: /\/courses\/detail\/194\//i,
        description: 'The tennis courts are by Messina Avenue and the bookable multi-use games area pitch is by the entrance on Kilburn High Road.'
    }
];
const TARGETS = [
    { key: 'talacre', pattern: /talacre/i },
    { key: 'swiss-cottage', pattern: /swiss cottage/i },
    { key: 'pancras-square', pattern: /pancras square/i },
    { key: 'kentish-town', pattern: /kentish town/i },
    { key: 'oasis', pattern: /oasis sports/i },
    { key: 'armoury', pattern: /armoury/i },
    { key: 'kings-cross', pattern: /king['’]s cross fitness/i },
    { key: 'lincolns-inn-fields', pattern: /lincoln['’]s inn fields/i },
    { key: 'kilburn-grange', pattern: /kilburn grange/i },
    { key: 'waterlow-park', pattern: /waterlow park/i }
];
const POSTCODE_PATTERN = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;

function cleanText(value) {
    return String(value || '')
        .replace(/\u00a0/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();
}

function getTargetKey(label) {
    return TARGETS.find(target => target.pattern.test(label))?.key || null;
}

function isAllowedHost(hostname) {
    return hostname === 'camden.gov.uk' || hostname.endsWith('.camden.gov.uk') ||
        hostname === 'better.org.uk' || hostname.endsWith('.better.org.uk') ||
        hostname === 'armourygym.co.uk' || hostname === 'www.armourygym.co.uk';
}

function collectFacilityLinks($, baseUrl, targetKey) {
    const links = [];
    $('a[href]').each((_, element) => {
        const label = cleanText($(element).text());
        const key = getTargetKey(label);
        if (!key || (targetKey && key !== targetKey)) {
            return;
        }

        let url;
        try {
            url = new URL($(element).attr('href'), baseUrl);
        } catch {
            return;
        }

        if (url.protocol === 'http:' && (url.hostname === 'camden.gov.uk' || url.hostname.endsWith('.camden.gov.uk'))) {
            url.protocol = 'https:';
        }
        if (!['http:', 'https:'].includes(url.protocol) || !isAllowedHost(url.hostname)) {
            return;
        }
        if (/\/courses\/(?!detail\/)/i.test(url.pathname)) {
            return;
        }
        if (/sports-centres-and-tennis-courts\/?$/i.test(url.pathname)) {
            return;
        }

        url.hash = '';
        if (!links.some(link => link.url === url.toString())) {
            links.push({ key, label, url: url.toString() });
        }
    });
    return links;
}

async function fetchPage(url) {
    const response = await fetch(url, {
        headers: {
            'user-agent': 'Mozilla/5.0 (compatible; ActiveHubFacilityImporter/1.0)',
            accept: 'text/html,application/xhtml+xml'
        },
        signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
    }

    const finalUrl = new URL(response.url);
    if (!isAllowedHost(finalUrl.hostname)) {
        throw new Error(`Redirected to an unsupported host: ${finalUrl.hostname}`);
    }

    const html = await response.text();
    return { url: finalUrl.toString(), html, $: cheerio.load(html) };
}

async function geocodeAddress(address, postcode, name) {
    // Whitespace is normalised first so the suffix patterns need no backtracking-prone \s+.
    const mapSearchName = name
        .replace(/\s/g, ' ')
        .replace(/ tennis courts?$/i, '')
        .replace(/ tennis court \d+$/i, '')
        .replace(/ multi-use games area$/i, '')
        .trim();
    const queries = [
        `${address}, ${postcode}, Camden, United Kingdom`,
        `${mapSearchName}, Camden, London, United Kingdom`,
        `${mapSearchName}, London, United Kingdom`
    ].filter((query, index, all) => all.indexOf(query) === index);

    for (const query of queries) {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    url.searchParams.set('q', query);

    await new Promise(resolve => setTimeout(resolve, 1000));
    const response = await fetch(url, {
        headers: { 'user-agent': 'ActiveHubFacilityImporter/1.0 (local facility directory import)' },
        signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
        throw new Error(`Geocoding returned HTTP ${response.status} for ${query}`);
    }

    const [result] = await response.json();
        if (!result) {
            continue;
        }
        const latitude = Number(result.lat);
        const longitude = Number(result.lon);
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
            return { latitude, longitude };
        }
    }
    return null;
}

function extractCoordinates($, html) {
    const values = [html];
    $('a[href], img[src]').each((_, element) => {
        values.push($(element).attr('href') || $(element).attr('src'));
    });

    const patterns = [
        /(?:center|markers|query|q)=(-?\d+(?:\.\d+)?)(?:,|%2c)\s*(-?\d+(?:\.\d+)?)/i,
        /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
        /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/i
    ];

    for (const value of values) {
        let decoded = String(value || '').replace(/&amp;/g, '&');
        try {
            decoded = decodeURIComponent(decoded);
        } catch {
            // Keep the original URL when it contains malformed escapes.
        }
        for (const pattern of patterns) {
            const match = decoded.match(pattern);
            if (!match) {
                continue;
            }
            const latitude = Number(match[1]);
            const longitude = Number(match[2]);
            if (latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
                return { latitude, longitude };
            }
        }
    }
    return null;
}

function extractFullAddress(bodyText) {
    const label = /Full Address\s+/i.exec(bodyText);
    if (!label) {
        return null;
    }
    const start = label.index + label[0].length;
    const rest = bodyText.slice(start, start + 242);
    const end = /\s(?:Directions|Location Description|Book court)\b/i.exec(rest);
    if (!end || end.index < 1 || end.index > 240) {
        return null;
    }
    const address = rest.slice(0, end.index).trimEnd();
    return address && !/[\r\n]/.test(address) ? address : null;
}

function trimTrailingSeparators(value) {
    let end = value.length;
    while (end > 0 && /[,;\s]/.test(value[end - 1])) {
        end -= 1;
    }
    return value.slice(0, end);
}

function extractAddress($, bodyText, name) {
    const fullAddress = extractFullAddress(bodyText);
    const candidates = [];
    if (fullAddress) {
        candidates.push(fullAddress);
    }
    const statedAddress = bodyText.match(/Our address is\s*(.{1,180}?\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})/i);
    if (statedAddress) {
        candidates.push(statedAddress[1]);
    }

    $('address, [itemprop="address"], p, li, td, dd').each((_, element) => {
        const text = cleanText($(element).text());
        if (text.length <= 260 && POSTCODE_PATTERN.test(text)) {
            candidates.push(text);
        }
    });

    candidates.sort((left, right) => left.length - right.length);
    for (const candidate of candidates) {
        const postcodeMatch = candidate.match(POSTCODE_PATTERN);
        if (!postcodeMatch) {
            continue;
        }
        let address = candidate.slice(0, postcodeMatch.index)
            .replace(/^(?:full address|address|location)\s*:?[\s]*/i, '')
            .trim();
        if (address.toLowerCase().startsWith(name.toLowerCase())) {
            address = address.slice(name.length).trim();
        }
        address = trimTrailingSeparators(address).trim();
        if (address.length >= 4) {
            return { address, postcode: postcodeMatch[1].replace(/\s+/g, ' ').toUpperCase() };
        }
    }
    return null;
}

function extractDescription($) {
    const metaDescription = cleanText(
        $('meta[name="description"]').attr('content') ||
        $('meta[property="og:description"]').attr('content')
    );
    if (metaDescription.length >= 20) {
        return metaDescription.slice(0, 10000);
    }

    const paragraphs = $('main p, article p, p').toArray()
        .map(element => cleanText($(element).text()))
        .filter(text => text.length >= 20 && text.length <= 1500 &&
            !/cookies?|privacy|accept all|analytics/i.test(text));
    return paragraphs[0]?.slice(0, 10000) || '';
}

function extractBookingUrl($, baseUrl) {
    const choices = [];
    $('a[href]').each((_, element) => {
        const label = cleanText($(element).text());
        const href = $(element).attr('href');
        if (!href || /^javascript:/i.test(href) || /\/courses\/book\.aspx/i.test(href)) {
            return;
        }

        let url;
        try {
            url = new URL(href, baseUrl);
        } catch {
            return;
        }
        if (!['http:', 'https:'].includes(url.protocol)) {
            return;
        }

        let score = 0;
        if (/book|booking|calendar|reserve|one.day pass|trial|join now/i.test(label)) score += 4;
        if (/\/activities\/?$/i.test(url.pathname)) score += 3;
        if (/\/courses\/detail\//i.test(url.pathname)) score += 2;
        if (score) choices.push({ score, url: url.toString() });
    });
    choices.sort((left, right) => right.score - left.score);
    return choices[0]?.url || baseUrl;
}

function extractFacility(page, candidate) {
    const { $, html, url } = page;
    const heading = cleanText($('h1').first().text());
    const bodyText = cleanText($('body').text());
    const name = NAME_OVERRIDES[candidate.key] ||
        (heading && !/sports directory|first thing in the morning/i.test(heading) ? heading : candidate.label);
    const location = extractAddress($, bodyText, name) || extractAddress($, bodyText, candidate.label);
    const coordinates = COORDINATE_OVERRIDES_BY_SOURCE.find(override => override.sourcePattern.test(candidate.url))?.coordinates ||
        COORDINATE_OVERRIDES[candidate.key] || extractCoordinates($, html);

    return {
        name,
        address: location?.address || '',
        postcode: location?.postcode || '',
        latitude: coordinates?.latitude ?? null,
        longitude: coordinates?.longitude ?? null,
        description: DESCRIPTION_OVERRIDES.find(override => override.sourcePattern.test(candidate.url))?.description || extractDescription($),
        booking_mode: 'external',
        external_booking_url: BOOKING_URL_OVERRIDES[candidate.key] || extractBookingUrl($, url),
        source_url: url
    };
}

function findCourseDetailUrl($, baseUrl) {
    const element = $('a[href*="/courses/detail/"]').first();
    if (!element.length) {
        return null;
    }
    try {
        const url = new URL(element.attr('href'), baseUrl);
        return isAllowedHost(url.hostname) ? url.toString() : null;
    } catch {
        return null;
    }
}

async function scrapeCandidate(candidate) {
    const pendingUrls = [FALLBACK_URLS[candidate.key] || candidate.url];
    const visitedUrls = new Set();

    while (pendingUrls.length) {
        const url = pendingUrls.shift();
        if (visitedUrls.has(url)) continue;
        visitedUrls.add(url);

        const page = await fetchPage(url);
        await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));
        const heading = cleanText(page.$('h1').first().text());
        if (/sports directory/i.test(heading)) {
            const matchingLinks = collectFacilityLinks(page.$, page.url, candidate.key);
            pendingUrls.push(...matchingLinks.map(link => link.url));
            continue;
        }

        let facility = extractFacility(page, candidate);
        if ((facility.latitude === null || facility.longitude === null) && facility.address && facility.postcode) {
            try {
                const coordinates = await geocodeAddress(facility.address, facility.postcode, facility.name);
                if (coordinates) {
                    facility = { ...facility, ...coordinates };
                }
            } catch (error) {
                console.warn(`Could not geocode ${facility.name}: ${error.message}`);
            }
        }
        const isComplete = item => item.address && item.postcode &&
            item.latitude !== null && item.longitude !== null && item.description;

        if (!isComplete(facility)) {
            const detailUrl = findCourseDetailUrl(page.$, page.url);
            if (detailUrl && !visitedUrls.has(detailUrl)) {
                const detailPage = await fetchPage(detailUrl);
                await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));
                const detail = extractFacility(detailPage, candidate);
                facility = {
                    ...detail,
                    ...facility,
                    name: facility.name || detail.name,
                    address: facility.address || detail.address,
                    postcode: facility.postcode || detail.postcode,
                    latitude: facility.latitude ?? detail.latitude,
                    longitude: facility.longitude ?? detail.longitude,
                    description: facility.description || detail.description,
                    external_booking_url: extractBookingUrl(page.$, page.url) || detailPage.url,
                    source_url: page.url
                };
                if ((facility.latitude === null || facility.longitude === null) && facility.address && facility.postcode) {
                    try {
                        const coordinates = await geocodeAddress(facility.address, facility.postcode, facility.name);
                        if (coordinates) {
                            facility = { ...facility, ...coordinates };
                        }
                    } catch (error) {
                        console.warn(`Could not geocode ${facility.name}: ${error.message}`);
                    }
                }
            }
        }

        if (isComplete(facility)) {
            return facility;
        }
    }
    return null;
}

async function main() {
    if (!DRY_RUN) {
        await Facilities.initialize();
    }

    const listing = await fetchPage(LISTING_URL);
    const candidates = collectFacilityLinks(listing.$, listing.url);
    if (!candidates.length) {
        throw new Error('No supported facility links were found on the Camden listing page.');
    }

    let upserted = 0;
    let skipped = 0;
    console.log(`Found ${candidates.length} facility links${DRY_RUN ? ' (dry run)' : ''}.`);

    for (const candidate of candidates) {
        try {
            const facility = await scrapeCandidate(candidate);
            if (!facility) {
                skipped += 1;
                console.warn(`Skipped ${candidate.label}: page did not expose a complete address, postcode, coordinates, and description.`);
                continue;
            }

            if (DRY_RUN) {
                console.log(`[dry run] ${facility.name} | ${facility.address}, ${facility.postcode} | ${facility.latitude}, ${facility.longitude} | ${facility.booking_mode} | ${facility.source_url}`);
            } else {
                await Facilities.upsertImported(facility);
                console.log(`Imported/updated ${facility.name}`);
            }
            upserted += 1;
        } catch (error) {
            skipped += 1;
            console.warn(`Skipped ${candidate.label}: ${error.message}`);
        }
    }

    console.log(`${DRY_RUN ? 'Ready' : 'Upserted'}: ${upserted}; skipped: ${skipped}.`);
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => Facilities.close());
