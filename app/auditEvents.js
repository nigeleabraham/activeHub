const crud = ['create', 'update', 'delete'];
const currentActions = [
    ...['facility', 'course', 'sport', 'opening_hours', 'resource', 'option', 'role', 'profile', 'course-run']
        .flatMap(entity => crud.map(action => `${entity}.${action}`)),
    ...['create', 'update', 'delete', 'order', 'move'].map(action => `sport-faq.${action}`),
    ...['create', 'update', 'destroy', 'order', 'move'].map(action => `sport-section.${action}`),
    ...['login', 'logout', 'view_as'].map(action => `auth.${action}`),
    ...['create', 'cancel', 'credit'].map(action => `booking.${action}`),
    ...['create', 'approve', 'decline', 'reopen'].map(action => `credit-request.${action}`),
    ...['request', 'approve', 'reopen'].map(action => `credit-refund.${action}`),
    'course-booking.cancel', 'credit.refundability', 'facility-sport.months', 'weather-slot.delete',
    ...['update', 'logo_update', 'logo_remove', 'credit_request_days', 'credit_slot_auto_approval',
        'booking_search_days', 'credit_lifetime_days', 'refunds_enabled',
        'course_prevent_duplicate_class', 'course_prevent_multiple_classes'].map(action => `settings.${action}`)
];

const descriptions = {
    'course-booking.cancel': 'Course attendee removed',
    'auth.login': 'Signed in', 'auth.logout': 'Signed out', 'auth.view_as': 'Active role changed',
    'booking.credit': 'Booking credit issued', 'credit.refundability': 'Credit refund eligibility changed',
    'facility-sport.months': 'Sport booking months changed',
    'settings.update': 'Setting changed', 'settings.logo_update': 'Logo updated', 'settings.logo_remove': 'Logo removed',
    'settings.credit_request_days': 'Credit request period changed',
    'settings.credit_slot_auto_approval': 'Weather credit auto-approval changed',
    'weather-slot.delete': 'Weather credit auto-approval slot deleted',
    'settings.booking_search_days': 'Booking search range changed',
    'settings.credit_lifetime_days': 'Credit lifetime changed', 'settings.refunds_enabled': 'Refunds setting changed',
    'settings.course_prevent_duplicate_class': 'Repeat class booking rule changed',
    'settings.course_prevent_multiple_classes': 'One class per course rule changed'
};
const verbs = {
    create: 'created', update: 'updated', delete: 'deleted', cancel: 'cancelled',
    approve: 'approved', decline: 'declined', reopen: 'reopened', request: 'requested',
    order: 'reordered', move: 'moved', destroy: 'deleted'
};

function words(value) {
    return value.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function actionLabel(code) {
    if (Object.hasOwn(descriptions, code)) return descriptions[code];
    const [entity, operation, extra] = code.split('.');
    const label = operation && !extra && Object.hasOwn(verbs, operation)
        ? `${words(entity)} ${verbs[operation]}`
        : words(code);
    return label ? label[0].toUpperCase() + label.slice(1) : code;
}

module.exports = { currentActions, actionLabel, words };
