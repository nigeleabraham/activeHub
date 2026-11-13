// Settings and financial reviews remain Administrator-only.
const PERMISSIONS = [
    { key: 'facilities.manage', area: 'Facilities', label: 'Manage facilities', description: 'Add, edit and delete facilities.' },
    { key: 'courses.manage', area: 'Courses', label: 'Manage courses', description: 'Add, edit and delete courses.' },
    { key: 'course_bookings.view', area: 'Course bookings', label: 'View course bookings and registers', description: 'Search course bookings, view booking and payment details, and print attendee registers. Does not permit cancellations or refunds.' },
    { key: 'sports.manage', area: 'Sports', label: 'Manage sports', description: 'Add, edit and delete sports.' },
    { key: 'opening_hours.manage', area: 'Opening hours', label: 'Manage opening hours', description: 'Add, edit and delete opening hours templates.' },
    { key: 'bookings.manage', area: 'Court bookings', label: 'Manage court bookings', description: 'Configure resources and options, make court bookings for any profile and cancel any court booking.' },
    { key: 'profiles.manage', area: 'Profiles', label: 'Manage profiles', description: 'Add, edit and delete profiles and assign them a role.' },
    { key: 'roles.manage', area: 'Roles', label: 'Manage roles', description: 'Create and edit roles and choose what each role can do.' },
    { key: 'audit.view', area: 'Audit', label: 'View audit log', description: 'Read the audit trail of changes.' }
];

const PERMISSION_KEYS = PERMISSIONS.map(permission => permission.key);

function adminPermissions(path) {
    if (path === '/courses/faqs' || path.startsWith('/courses/faqs/')) return [];
    if (path === '/profiles/search') return ['profiles.manage', 'bookings.manage'];
    if (path === '/facilities/courses/destroy') return ['courses.manage'];
    const area = path.split('/')[1];
    const permissions = {
        facilities: 'facilities.manage', courses: 'courses.manage', sports: 'sports.manage',
        'opening-hours': 'opening_hours.manage', bookings: 'bookings.manage',
        'court-configuration': 'bookings.manage', 'booking-search': 'bookings.manage', profiles: 'profiles.manage',
        'course-bookings': 'course_bookings.view',
        'course-management': 'course_bookings.view',
        roles: 'roles.manage', audit: 'audit.view'
    };
    return permissions[area] ? [permissions[area]] : [];
}

module.exports = { PERMISSIONS, PERMISSION_KEYS, adminPermissions };
