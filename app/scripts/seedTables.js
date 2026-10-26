// Tables captured in seed/data.json, in the order they must be inserted.
// keyBy: models seed their own defaults on startup, so these tables are matched by name rather than guid.
// remap: foreign keys that must follow a keyBy table's real guid.
const TABLES = [
    { name: 'sports', keyBy: 'name', orderBy: 'LOWER(name)', json: ['course_description_sections'] },
    { name: 'opening_hours_templates', keyBy: 'name', orderBy: 'LOWER(name)' },
    { name: 'roles', keyBy: 'name', orderBy: 'LOWER(name)', skip: ['guid'] },
    { name: 'profiles', keyBy: 'email', orderBy: 'LOWER(email)', skip: ['credit_pence'],
        remap: { interest_sport_guids: 'sports' } },
    { name: 'profile_roles', orderBy: 'profile_guid, role', remap: { profile_guid: 'profiles' } },
    // The app creates default rules for its default template; on the first seed the snapshot's hours replace them.
    { name: 'opening_hours_rules', orderBy: 'template_guid, day_of_week', remap: { template_guid: 'opening_hours_templates' },
        upsert: { conflict: ['template_guid', 'day_of_week'], update: ['opens_at', 'closes_at'] } },
    { name: 'facilities', orderBy: 'name', remap: { opening_hours_template_guid: 'opening_hours_templates' } },
    { name: 'facility_sports', orderBy: 'facility_guid, sport_guid', remap: { sport_guid: 'sports' } },
    { name: 'courses', orderBy: 'name', remap: { description_sport_guid: 'sports' },
        json: ['description_overrides', 'description_sections'] },
    { name: 'course_facilities', orderBy: 'course_guid, facility_guid' },
    { name: 'course_sports', orderBy: 'course_guid, sport_guid', remap: { sport_guid: 'sports' } },
    { name: 'course_runs', orderBy: 'course_guid, guid' },
    { name: 'course_sessions', orderBy: 'run_guid, starts_at' },
    { name: 'sport_course_faqs', orderBy: 'sport_guid, created_at, guid', remap: { sport_guid: 'sports' } },
    { name: 'booking_resources', orderBy: 'facility_guid, name' },
    { name: 'bookable_options', orderBy: 'facility_guid, name', remap: { sport_guid: 'sports' } },
    { name: 'bookable_option_resources', orderBy: 'option_guid, resource_guid' },
    { name: 'site_settings', orderBy: 'key' },
    { name: 'site_logo', orderBy: 'id' }
];

// Written to site_settings once seeding has run, so restarts never overwrite later admin edits.
const SEEDED_KEY = 'seeded_at';

// role_permissions refers to roles by name so it survives roles being created with new guids.
const ROLE_PERMISSIONS_QUERY = `
    SELECT r.name AS role, rp.permission
    FROM role_permissions rp JOIN roles r ON r.guid = rp.role_guid
    ORDER BY LOWER(r.name), rp.permission`;

module.exports = { TABLES, ROLE_PERMISSIONS_QUERY, SEEDED_KEY };
