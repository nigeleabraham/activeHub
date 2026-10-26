const adult = {
    name: ['name'],
    contact: ['email', 'telephone', 'emergency_contact_name', 'emergency_contact_telephone'],
    address: ['address_line_1', 'address_line_2', 'town_city', 'county', 'postcode'],
    health: ['medical_concern', 'medical_conditions', 'medical_other', 'activity_limitation'],
    membership: ['membership_number'],
    interests: ['interest_sport_guids']
};
const child = {
    name: ['name', 'date_of_birth'],
    parental_contact: ['inherit_parental_contact', 'parental_contact_name', 'parental_contact_email', 'parental_contact_telephone'],
    emergency_contact: ['inherit_emergency_contact', 'emergency_contact_name', 'emergency_contact_telephone'],
    address: ['inherit_address', ...adult.address],
    health: adult.health,
    membership: adult.membership,
    interests: adult.interests
};

function fields(section, isChild = false) {
    const sections = isChild ? child : adult;
    return typeof section === 'string' && Object.hasOwn(sections, section) ? sections[section] : null;
}

// Validate only the selected section; unrelated legacy fields may still be unanswered.
function input(body, section, isChild = false) {
    const selected = fields(section, isChild);
    if (!selected) throw new Error('Unknown profile section.');
    const defaults = {
        name: 'Profile', email: 'profile@example.com', medical_concern: 'no', activity_limitation: 'no',
        inherit_address: 'yes', inherit_parental_contact: 'yes', inherit_emergency_contact: 'yes'
    };
    for (const field of selected) defaults[field] = body[field];
    return defaults;
}

module.exports = { fields, input };
