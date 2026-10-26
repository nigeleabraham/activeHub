const { Pool } = require('pg');
const { isValidEmail, isValidCourseDates } = require('../validation');
const ProfileSections = require('./ProfileSections');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const groups = {
    address: ['address_line_1', 'address_line_2', 'town_city', 'county', 'postcode'],
    parental_contact: ['parental_contact_name', 'parental_contact_email', 'parental_contact_telephone'],
    emergency_contact: ['emergency_contact_name', 'emergency_contact_telephone']
};

class ChildInputError extends Error {}

async function initialize() {
    await pool.query(`ALTER TABLE profile_family_members
        ADD COLUMN IF NOT EXISTS date_of_birth date,
        ADD COLUMN IF NOT EXISTS inherit_address boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS inherit_parental_contact boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS inherit_emergency_contact boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS address_line_1 text,
        ADD COLUMN IF NOT EXISTS address_line_2 text,
        ADD COLUMN IF NOT EXISTS town_city text,
        ADD COLUMN IF NOT EXISTS county text,
        ADD COLUMN IF NOT EXISTS postcode text,
        ADD COLUMN IF NOT EXISTS parental_contact_name text,
        ADD COLUMN IF NOT EXISTS parental_contact_email text,
        ADD COLUMN IF NOT EXISTS parental_contact_telephone text,
        ADD COLUMN IF NOT EXISTS emergency_contact_name text,
        ADD COLUMN IF NOT EXISTS emergency_contact_telephone text,
        ADD COLUMN IF NOT EXISTS medical_concern boolean,
        ADD COLUMN IF NOT EXISTS medical_conditions text[] NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS medical_other text,
        ADD COLUMN IF NOT EXISTS activity_limitation text CHECK (activity_limitation IN ('limited_a_lot', 'limited_a_little', 'no')),
        ADD COLUMN IF NOT EXISTS membership_number text,
        ADD COLUMN IF NOT EXISTS interest_sport_guids uuid[] NOT NULL DEFAULT '{}'`);
}

function parse(body) {
    const text = (field, max) => {
        if (body[field] !== undefined && typeof body[field] !== 'string') throw new ChildInputError('Check the child profile fields.');
        const value = body[field]?.trim() || null;
        if (value && value.length > max) throw new ChildInputError(`The ${field.replaceAll('_', ' ')} is too long.`);
        return value;
    };
    const result = { name: text('name', 120), membership_number: text('membership_number', 120) };
    result.date_of_birth = text('date_of_birth', 10);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
    if (result.date_of_birth && (!isValidCourseDates(result.date_of_birth, result.date_of_birth) || result.date_of_birth > today)) {
        throw new ChildInputError('Enter a valid date of birth that is not in the future.');
    }
    if (!result.name) throw new ChildInputError('Enter the child’s name.');
    for (const [group, fields] of Object.entries(groups)) {
        const value = body[`inherit_${group}`];
        if (!['yes', 'no'].includes(value)) throw new ChildInputError('Choose whether to inherit each contact and address group.');
        result[`inherit_${group}`] = value === 'yes';
        for (const field of fields) {
            result[field] = value === 'yes' ? null : text(field,
                field.includes('telephone') ? 40 : field.includes('email') ? 254 :
                    field === 'postcode' ? 20 : field.startsWith('address_line') ? 160 : 120);
            const entered = result[field];
            if (entered && field.includes('telephone') && (!/^[+0-9().\s-]+$/.test(entered) || !/[0-9]/.test(entered))) {
                throw new ChildInputError('Enter valid parental and emergency telephone numbers.');
            }
            if (entered && field.includes('email') && !isValidEmail(entered)) throw new ChildInputError('Enter a valid parental email address.');
        }
    }
    if (!['yes', 'no'].includes(body.medical_concern) ||
        !['limited_a_lot', 'limited_a_little', 'no'].includes(body.activity_limitation)) {
        throw new ChildInputError('Answer both health questions for the child.');
    }
    result.medical_concern = body.medical_concern === 'yes';
    result.activity_limitation = body.activity_limitation;
    result.medical_conditions = [];
    result.medical_other = null;
    if (result.medical_concern) {
        const submitted = Array.isArray(body.medical_conditions) ? body.medical_conditions : [body.medical_conditions];
        if (!submitted.length || submitted.some(value => !['asthma', 'epilepsy', 'epipen', 'other'].includes(value))) {
            throw new ChildInputError('Select at least one medical condition.');
        }
        result.medical_conditions = [...new Set(submitted)];
        if (result.medical_conditions.includes('other')) {
            result.medical_other = text('medical_other', 1000);
            if (!result.medical_other) throw new ChildInputError('Describe the other medical concern.');
        }
    }
    const interests = body.interest_sport_guids === undefined ? [] :
        Array.isArray(body.interest_sport_guids) ? body.interest_sport_guids : [body.interest_sport_guids];
    if (interests.length > 100 || interests.some(value => typeof value !== 'string' || !GUID.test(value))) {
        throw new ChildInputError('Choose existing sports for the child’s interests.');
    }
    result.interest_sport_guids = [...new Set(interests)];
    return result;
}

function resolve(child, parent) {
    const resolved = { ...child };
    for (const [group, fields] of Object.entries(groups)) {
        if (!child[`inherit_${group}`]) continue;
        for (const field of fields) {
            const parentField = field.startsWith('parental_contact_') ? field.replace('parental_contact_', '') : field;
            resolved[field] = parent[parentField] || null;
        }
    }
    return resolved;
}

async function find(profileGuid, guid) {
    if (typeof guid !== 'string' || !GUID.test(guid)) return null;
    const { rows: [child] } = await pool.query(`
        SELECT m.*, to_char(m.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
            ARRAY(SELECT guid FROM sports WHERE guid = ANY(m.interest_sport_guids)) AS interest_sport_guids
        FROM profile_family_members m JOIN profiles p ON p.guid = m.profile_guid
        WHERE m.profile_guid = $1 AND m.guid = $2 AND m.deleted_at IS NULL AND p.deleted_at IS NULL`, [profileGuid, guid]);
    return child || null;
}

async function save(profileGuid, guid, body, section = null) {
    if (guid !== null && (typeof guid !== 'string' || !GUID.test(guid))) throw new ChildInputError('Choose an existing child.');
    if (section !== null && (!guid || !ProfileSections.fields(section, true))) throw new ChildInputError('Choose an existing child profile section.');
    const parsed = parse(section === null ? body : ProfileSections.input(body, section, true));
    const values = section === null ? parsed : Object.fromEntries(ProfileSections.fields(section, true).map(field => [field, parsed[field]]));
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const owner = await client.query('SELECT guid FROM profiles WHERE guid=$1 AND deleted_at IS NULL FOR UPDATE', [profileGuid]);
        if (!owner.rowCount) {
            await client.query('ROLLBACK');
            return null;
        }
        if (values.interest_sport_guids?.length) {
            const sports = await client.query('SELECT guid FROM sports WHERE guid = ANY($1::uuid[]) FOR SHARE', [values.interest_sport_guids]);
            if (sports.rowCount !== values.interest_sport_guids.length) throw new ChildInputError('Choose existing sports for the child’s interests.');
        }
        const fields = Object.keys(values);
        const parameters = [profileGuid, ...fields.map(field => values[field])];
        const result = guid === null ? await client.query(`
            INSERT INTO profile_family_members(profile_guid, ${fields.join(', ')})
            VALUES ($1, ${fields.map((_, index) => `$${index + 2}`).join(', ')}) RETURNING guid`, parameters) :
            await client.query(`
                UPDATE profile_family_members SET ${fields.map((field, index) => `${field}=$${index + 2}`).join(', ')}
                WHERE profile_guid=$1 AND guid=$${parameters.length + 1} AND deleted_at IS NULL RETURNING guid`,
            [...parameters, guid]);
        await client.query('COMMIT');
        if (!result.rows[0]) return null;
        return section === null ? result.rows[0] : { ...result.rows[0], values };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { initialize, parse, resolve, find, save, ChildInputError };
