// Responsibilities that can be assigned to roles. They are recorded now and will gate features outside the
// administrator-only /admin area as those are built.
const PERMISSIONS = [
    { key: 'facilities.manage', area: 'Facilities', label: 'Manage facilities', description: 'Add, edit and delete facilities.' },
    { key: 'courses.manage', area: 'Courses', label: 'Manage courses', description: 'Add, edit and delete courses.' },
    { key: 'sports.manage', area: 'Sports', label: 'Manage sports', description: 'Add, edit and delete sports.' },
    { key: 'opening_hours.manage', area: 'Opening hours', label: 'Manage opening hours', description: 'Add, edit and delete opening hours templates.' },
    { key: 'bookings.manage', area: 'Bookings', label: 'Manage bookings', description: 'Configure resources and options, make bookings for any profile and cancel any booking.' },
    { key: 'profiles.manage', area: 'Profiles', label: 'Manage profiles', description: 'Add, edit and delete profiles and assign them a role.' },
    { key: 'roles.manage', area: 'Roles', label: 'Manage roles', description: 'Create and edit roles and choose what each role can do.' },
    { key: 'audit.view', area: 'Audit', label: 'View audit log', description: 'Read the audit trail of changes.' }
];

const PERMISSION_KEYS = PERMISSIONS.map(permission => permission.key);

module.exports = { PERMISSIONS, PERMISSION_KEYS };
