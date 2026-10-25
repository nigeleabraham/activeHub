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

module.exports = { isValidEmail };
