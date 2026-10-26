const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sections(value) {
    if (!Array.isArray(value) || value.length > 50) throw new Error('Maximum 50 description sections');
    const ids = new Set();
    return value.map(section => {
        if (!section || typeof section.id !== 'string' || !UUID.test(section.id) || ids.has(section.id) ||
            typeof section.heading !== 'string' || section.heading.length > 160 ||
            typeof section.text !== 'string' || !section.text.trim() || section.text.length > 10000) {
            throw new Error('Invalid description section');
        }
        ids.add(section.id);
        return { id: section.id, heading: section.heading.trim(), text: section.text.trim() };
    });
}

function descriptionConfig(source, overrides, extra, sportGuids) {
    if (source !== null && (typeof source !== 'string' || !UUID.test(source) || !sportGuids.includes(source))) {
        throw new Error('Choose an assigned sport for default sections');
    }
    if (!overrides || Array.isArray(overrides) || typeof overrides !== 'object' || Object.keys(overrides).length > 50) {
        throw new Error('Invalid section overrides');
    }
    const normalized = {};
    for (const [id, value] of Object.entries(overrides)) {
        normalized[id] = sections([{ ...value, id }])[0];
    }
    return { description_sport_guid: source, description_overrides: normalized, description_sections: sections(extra) };
}

function resolveDescription(course, defaults) {
    return [...defaults.map(section => course.description_overrides?.[section.id] || section),
        ...(course.description_sections || [])];
}

module.exports = { sections, descriptionConfig, resolveDescription };
