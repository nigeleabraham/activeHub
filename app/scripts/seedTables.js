// Tables captured in seed/data.json, in the order they must be inserted.
// keyBy: models seed their own defaults on startup, so these tables are matched by name rather than guid.
// remap: foreign keys that must follow a keyBy table's real guid.
const TABLES = [
    { name: 'sports', keyBy: 'name', orderBy: 'LOWER(name)' },
    { name: 'opening_hours_templates', keyBy: 'name', orderBy: 'LOWER(name)' },
    { name: 'roles', keyBy: 'name', orderBy: 'LOWER(name)', skip: ['guid'] },
    { name: 'profiles', keyBy: 'email', orderBy: 'LOWER(email)' },
    // The app creates default rules for its default template; on the first seed the snapshot's hours replace them.
    { name: 'opening_hours_rules', orderBy: 'template_guid, day_of_week', remap: { template_guid: 'opening_hours_templates' },
        upsert: { conflict: ['template_guid', 'day_of_week'], update: ['opens_at', 'closes_at'] } },
    { name: 'facilities', orderBy: 'name', remap: { opening_hours_template_guid: 'opening_hours_templates' } },
    { name: 'facility_sports', orderBy: 'facility_guid, sport_guid', remap: { sport_guid: 'sports' } },
    { name: 'courses', orderBy: 'name' },
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
