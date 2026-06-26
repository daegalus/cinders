// SPDX-License-Identifier: BlueOak-1.0.0

function escapeRegex(value) {
    return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function normalize(value) {
    return value.trim().toLowerCase();
}

function compileRegex(value) {
    if (value.startsWith('regex:')) {
        return new RegExp(value.slice(6));
    }

    if (!value.startsWith('/')) {
        return null;
    }

    const end = value.lastIndexOf('/');
    if (end <= 0) {
        return null;
    }

    const pattern = value.slice(1, end);
    const flags = value.slice(end + 1);
    return new RegExp(pattern, flags);
}

function compileGlob(value) {
    const pattern = value
        .split('*')
        .map((part) => escapeRegex(normalize(part)))
        .join('.*');

    return new RegExp(`^${pattern}$`);
}

export function splitRepositoryFilters(value) {
    return value
        .split(/[\n,]+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
}

export function joinRepositoryFilters(filters) {
    return filters.join(', ');
}

export function validateRepositoryFilters(filters) {
    for (const filter of filters) {
        try {
            compileRegex(filter);
        } catch (error) {
            return error.message;
        }
    }

    return null;
}

export function repositoryMatchesFilters(repository, filters) {
    if (!repository || filters.length === 0) {
        return false;
    }

    const normalizedRepository = normalize(repository);
    const [owner] = normalizedRepository.split('/', 1);

    for (const filter of filters) {
        const trimmed = filter.trim();
        if (!trimmed) {
            continue;
        }

        let regex = null;
        try {
            regex = compileRegex(trimmed);
        } catch (error) {
            continue;
        }

        if (regex !== null) {
            if (regex.test(repository)) {
                return true;
            }
            continue;
        }

        const normalizedFilter = normalize(trimmed);

        if (normalizedFilter.includes('*')) {
            if (compileGlob(normalizedFilter).test(normalizedRepository)) {
                return true;
            }
            continue;
        }

        if (!normalizedFilter.includes('/')) {
            if (owner === normalizedFilter) {
                return true;
            }
            continue;
        }

        if (normalizedRepository === normalizedFilter) {
            return true;
        }
    }

    return false;
}
