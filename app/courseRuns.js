const { isValidCourseDates } = require('./validation');

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function parseRunInput(body) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 120 ||
        typeof body.price !== 'string' || !/^\d{1,6}(?:\.\d{1,2})?$/.test(body.price) ||
        typeof body.capacity !== 'string' || !/^[1-9]\d{0,4}$/.test(body.capacity)) return null;
    const [pounds, pennies = ''] = body.price.split('.');
    const full_price_pence = Number(pounds) * 100 + Number(pennies.padEnd(2, '0'));
    let sessions = [];
    if (body.schedule_mode === 'weekly') {
        if (!isValidCourseDates(body.start_date, body.end_date) ||
            typeof body.weekday !== 'string' || !/^[0-6]$/.test(body.weekday) ||
            typeof body.start_time !== 'string' || typeof body.end_time !== 'string' ||
            !TIME.test(body.start_time || '') || !TIME.test(body.end_time || '') ||
            body.end_time <= body.start_time) return null;
        const start = new Date(`${body.start_date}T00:00:00Z`);
        const end = new Date(`${body.end_date}T00:00:00Z`);
        if ((end - start) / 86400000 > 730) return null;
        for (let timestamp = start.getTime(); timestamp <= end.getTime(); timestamp += 86400000) {
            const date = new Date(timestamp);
            if (date.getUTCDay() === Number(body.weekday)) {
                const day = date.toISOString().slice(0, 10);
                sessions.push({ starts_local: `${day} ${body.start_time}`, ends_local: `${day} ${body.end_time}` });
            }
        }
    } else if (body.schedule_mode === 'individual' && typeof body.sessions === 'string' && body.sessions.length <= 20000) {
        const lines = body.sessions.trim().split(/\r?\n/);
        for (const line of lines) {
            const match = /^(\d{4}-\d{2}-\d{2}) ([0-2]\d:[0-5]\d) ([0-2]\d:[0-5]\d)$/.exec(line.trim());
            if (!match || !isValidCourseDates(match[1], match[1]) ||
                !TIME.test(match[2]) || !TIME.test(match[3]) || match[3] <= match[2]) return null;
            sessions.push({ starts_local: `${match[1]} ${match[2]}`, ends_local: `${match[1]} ${match[3]}` });
        }
    } else return null;
    sessions.sort((a, b) => a.starts_local.localeCompare(b.starts_local));
    if (!sessions.length || sessions.length > 366 ||
        sessions.some((session, index) => index && session.starts_local < sessions[index - 1].ends_local)) return null;
    return { name: body.name.trim(), full_price_pence, capacity: Number(body.capacity), sessions };
}

function priceForRemainingSessions(fullPrice, total, remaining) {
    if (!Number.isSafeInteger(fullPrice) || fullPrice < 0 || !Number.isInteger(total) || total < 1 ||
        !Number.isInteger(remaining) || remaining < 0 || remaining > total) throw new Error('Invalid course price or session count');
    return Math.round(fullPrice * remaining / total);
}

function courseAge(name) {
    const age = /\bages?\s*(\d{1,2})\b/i.exec(name);
    if (age) return Number(age[1]);
    if (/\bpre[- ]school\b/i.test(name)) return 3;
    if (/\breception\b/i.test(name)) return 4;
    const year = /\b(?:school\s+)?years?\s*:?\s*(\d{1,2})\b/i.exec(name);
    return year ? Number(year[1]) + 4 : Infinity;
}

function compareCourses(first, second) {
    const firstAge = courseAge(first.name);
    const secondAge = courseAge(second.name);
    return (firstAge === secondAge ? 0 : firstAge < secondAge ? -1 : 1) ||
        first.name.localeCompare(second.name, 'en-GB', { numeric: true, sensitivity: 'base' }) ||
        first.guid.localeCompare(second.guid);
}

function runOrder(run) {
    const first = run.sessions.reduce((earliest, session) =>
        !earliest || session.starts_local < earliest ? session.starts_local : earliest, '');
    if (first) {
        const day = new Date(`${first.slice(0, 10)}T12:00:00Z`).getUTCDay();
        return { day, time: first.slice(11) };
    }
    const day = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i.exec(run.name);
    const time = /\b(?:[01]\d|2[0-3]):[0-5]\d\b/.exec(run.name);
    return { day: day ? ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
        .indexOf(day[1].toLowerCase()) : 7, time: time?.[0] || '99:99' };
}

function compareRuns(first, second) {
    const a = runOrder(first);
    const b = runOrder(second);
    return a.day - b.day || a.time.localeCompare(b.time) ||
        first.facility_name.localeCompare(second.facility_name, 'en-GB', { numeric: true, sensitivity: 'base' }) ||
        first.name.localeCompare(second.name, 'en-GB', { numeric: true, sensitivity: 'base' }) ||
        first.guid.localeCompare(second.guid);
}

module.exports = { parseRunInput, priceForRemainingSessions, compareCourses, compareRuns };
