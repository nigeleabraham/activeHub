function isValidEmail(email) {
    if (typeof email !== 'string' || /\s/.test(email)) {
        return false;
    }

    const atIndex = email.indexOf('@');
    if (atIndex <= 0 || atIndex !== email.lastIndexOf('@')) {
        return false;
    }

    const domain = email.slice(atIndex + 1);
    const separatorIndex = domain.indexOf('.', 1);
    return separatorIndex > 0 && separatorIndex < domain.length - 1;
}

function parseDeclineComment(value) {
    if (typeof value !== 'string') return null;
    const comment = value.trim();
    return comment && comment.length <= 500 ? comment : null;
}

function parseBookingMonths(value) {
    const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
    if (values.length > 12 || values.some(month => typeof month !== 'string' || !/^(?:[1-9]|1[0-2])$/.test(month))) return null;
    return [...new Set(values.map(Number))].sort((a, b) => a - b);
}

module.exports = { isValidEmail, parseDeclineComment, parseBookingMonths };
