const { Pool } = require('pg');

const ORIGIN = 'https://camdenactive.camden.gov.uk';
const INDEX = '/courses/7/gymnastics/';
const MARKER = 'camden_course_import:';

function text(html) {
    return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'")
        .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

async function getPage(path) {
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN) throw new Error('Unexpected source origin');
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}: ${url}`);
    return response.text();
}

function links(html, type) {
    return [...new Set([...html.matchAll(/href="([^"]+)"/g)].map(match => match[1])
        .filter(path => path.startsWith(`/courses/${type}/`)))];
}

function parseSessions(html) {
    const section = html.split('Session Times</h4>')[1]?.split('</table>')[0];
    if (!section) throw new Error('Missing source session table');
    const sessions = [];
    for (const row of section.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
        const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(match => text(match[1]));
        if (!cells.length) continue;
        const date = /^\w+ (\d{1,2}) (\w{3}) (\d{4})$/.exec(cells[0]);
        const times = /^(\d{2}:\d{2}) - (\d{2}:\d{2})$/.exec(cells[1]);
        const month = date && ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(date[2]);
        if (!date || month < 0 || !times || cells.length !== 3) throw new Error('Unrecognised source session row');
        const day = `${date[3]}-${String(month + 1).padStart(2, '0')}-${date[1].padStart(2, '0')}`;
        sessions.push({ starts_local: `${day} ${times[1]}`, ends_local: `${day} ${times[2]}`, location: cells[2] });
    }
    if (!sessions.length) throw new Error('Source has no session dates');
    return sessions;
}

function parsePrice(html) {
    const source = text(html);
    const perSession = /Per session: £(\d+\.\d{2})/.exec(source);
    const counts = /There are (\d+) weeks remaining of a (\d+) week course/.exec(source);
    const total = /Total cost: £(\d+\.\d{2})/.exec(source);
    if (!perSession || !counts || !total) throw new Error('Missing source price or original session count');
    const pennies = value => Number(value.replace('.', ''));
    const remaining = Number(counts[1]);
    const original = Number(counts[2]);
    if (remaining < 1 || remaining > original || pennies(total[1]) !== pennies(perSession[1]) * remaining) {
        throw new Error('Source price and session counts do not agree');
    }
    return { full_price_pence: pennies(perSession[1]) * original, original_sessions: original,
        advertised_remaining: remaining, advertised_price_pence: pennies(total[1]) };
}

function summary(name) {
    const audience = name.replace(/\s*Autumn term 2026\s*$/i, '');
    return `${audience}. Autumn 2026 gymnastics tuition using apparatus to develop movement skills, balance and coordination.

Imported from Camden Active. Runs are drafts: the website does not publish maximum capacity and lists only remaining session dates. Before publishing, confirm capacity and restore the complete original session schedule so prorated prices use the correct total. Full-course prices exclude membership charges and discounts.`;
}

async function collect() {
    const listing = await getPage(INDEX);
    const paths = links(listing, 'detail');
    if (!paths.length) throw new Error('No advertised gymnastics courses found');
    const courses = [];
    for (const path of paths) {
        const html = await getPage(path);
        const name = text(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] || '');
        if (!name || name.length > 160) throw new Error(`Missing or oversized course name: ${path}`);
        const runs = [];
        for (const runPath of links(html, 'sessions')) {
            console.log(`Reading session facts: ${ORIGIN}${runPath}`);
            const page = await getPage(runPath);
            if (!page.includes('Session Times</h4>')) {
                console.warn(`Not imported: source does not expose session details at ${ORIGIN}${runPath}`);
                continue;
            }
            const sessions = parseSessions(page);
            const price = parsePrice(page);
            if (sessions.length !== price.advertised_remaining) throw new Error(`Session count mismatch: ${runPath}`);
            runs.push({ source: ORIGIN + runPath, ...price, sessions });
        }
        courses.push({ name, description: summary(name), source: ORIGIN + path, runs });
    }
    return courses;
}

async function importCourses(pool, courses) {
    const client = await pool.connect();
    const result = { courses_added: 0, runs_added: 0, runs_skipped: 0, sessions_added: 0 };
    try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('camden-course-import'))");
        const { rows: sports } = await client.query("SELECT guid FROM sports WHERE LOWER(name)='gymnastics'");
        if (sports.length !== 1) throw new Error('Expected exactly one Gymnastics sport');
        const { rows: facilities } = await client.query('SELECT guid, name FROM facilities');
        for (const course of courses) {
            const marker = MARKER + course.source;
            const found = await client.query('SELECT value FROM site_settings WHERE key=$1', [marker]);
            let guid = found.rows[0]?.value;
            if (guid) {
                if (!(await client.query('SELECT 1 FROM courses WHERE guid=$1', [guid])).rowCount) {
                    throw new Error(`Previously imported course was deleted; refusing to recreate it: ${course.name}`);
                }
            } else {
                const existing = await client.query('SELECT guid FROM courses WHERE LOWER(name)=LOWER($1)', [course.name]);
                if (existing.rowCount > 1) throw new Error(`Ambiguous existing course: ${course.name}`);
                guid = existing.rows[0]?.guid;
                if (!guid) {
                    guid = (await client.query(`INSERT INTO courses (name, description, runs_migrated)
                        VALUES ($1,$2,true) RETURNING guid`, [course.name, course.description])).rows[0].guid;
                    await client.query('INSERT INTO course_sports (course_guid,sport_guid) VALUES ($1,$2)', [guid, sports[0].guid]);
                    result.courses_added++;
                }
                await client.query('INSERT INTO site_settings (key,value) VALUES ($1,$2)', [marker, guid]);
            }
            for (const run of course.runs) {
                const runMarker = MARKER + run.source;
                if ((await client.query('SELECT 1 FROM site_settings WHERE key=$1', [runMarker])).rowCount) {
                    result.runs_skipped++;
                    continue;
                }
                const locations = [...new Set(run.sessions.map(session => session.location))];
                if (locations.length !== 1) throw new Error(`Run changes venue: ${run.source}`);
                const aliases = { 'Talacre Sports Centre (Gymnasium)': 'Talacre Community Sports Centre' };
                const location = aliases[locations[0]] || locations[0];
                const matched = facilities.filter(facility => facility.name.toLowerCase() === location.toLowerCase());
                if (matched.length !== 1) throw new Error(`No unambiguous facility match for ${locations[0]}`);
                const date = new Date(run.sessions[0].starts_local.slice(0, 10) + 'T12:00:00Z');
                const day = date.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
                const name = `${day} ${run.sessions[0].starts_local.slice(11)} (imported draft)`;
                const { rows: [created] } = await client.query(`INSERT INTO course_runs
                    (course_guid,facility_guid,name,full_price_pence,capacity,published)
                    VALUES ($1,$2,$3,$4,NULL,false) RETURNING guid`,
                [guid, matched[0].guid, name, run.full_price_pence]);
                for (const session of run.sessions) {
                    await client.query(`INSERT INTO course_sessions (run_guid,starts_at,ends_at)
                        VALUES ($1,$2::timestamp AT TIME ZONE 'Europe/London',$3::timestamp AT TIME ZONE 'Europe/London')`,
                    [created.guid, session.starts_local, session.ends_local]);
                    result.sessions_added++;
                }
                await client.query('INSERT INTO site_settings (key,value) VALUES ($1,$2)',
                    [runMarker, JSON.stringify({ guid: created.guid, original_sessions: run.original_sessions,
                        advertised_remaining: run.advertised_remaining, advertised_price_pence: run.advertised_price_pence,
                        imported_at: new Date().toISOString() })]);
                result.runs_added++;
            }
        }
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function main() {
    const courses = await collect();
    console.log(JSON.stringify(courses.map(course => ({ name: course.name, source: course.source,
        runs: course.runs.map(run => ({ source: run.source, ...parsePriceSummary(run),
            locations: [...new Set(run.sessions.map(session => session.location))] })) })), null, 2));
    if (!process.argv.includes('--apply')) {
        console.log('Dry run only. Pass --apply to add missing courses and draft runs without overwriting existing data.');
        return;
    }
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
        console.log(JSON.stringify(await importCourses(pool, courses)));
    } finally {
        await pool.end();
    }
}

function parsePriceSummary(run) {
    return { full_price_pence: run.full_price_pence, original_sessions: run.original_sessions,
        remaining_sessions: run.sessions.length, advertised_price_pence: run.advertised_price_pence };
}

if (require.main === module) main().catch(error => { console.error('Camden course import failed:', error); process.exitCode = 1; });

module.exports = { parseSessions, parsePrice, summary, importCourses };
