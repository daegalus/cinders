// SPDX-License-Identifier: MIT

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import { session } from './util.js';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

function encodeFormComponent(value) {
    return GLib.uri_escape_string(String(value), null, false).replaceAll(
        '%20',
        '+',
    );
}

function decodeFormComponent(value) {
    return decodeURIComponent(value.replaceAll('+', ' '));
}

function encodeForm(params) {
    return Object.entries(params)
        .filter(([_key, value]) => value !== undefined && value !== null)
        .map(
            ([key, value]) =>
                `${encodeFormComponent(key)}=${encodeFormComponent(value)}`,
        )
        .join('&');
}

function decodeForm(value) {
    const params = {};
    if (!value) return params;

    for (const pair of value.split('&')) {
        const [key, val = ''] = pair.split('=', 2);
        params[decodeFormComponent(key)] = decodeFormComponent(val);
    }

    return params;
}

function buildURL(url, params) {
    const separator = url.includes('?') ? '&' : '?';
    const query = encodeForm(params);
    return query ? `${url}${separator}${query}` : url;
}

function waitSeconds(seconds) {
    return new Promise((resolve) => {
        GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            Math.max(1, seconds),
            () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            },
        );
    });
}

async function postForm(url, params) {
    const message = Soup.Message.new('POST', url);
    const body = encodeForm(params);
    message.set_request_body_from_bytes(
        'application/x-www-form-urlencoded',
        new GLib.Bytes(encoder.encode(body)),
    );
    message.request_headers.append('Accept', 'application/json');

    const bytes = await session.send_and_read_async(
        message,
        GLib.PRIORITY_DEFAULT,
        null,
    );
    const contents = decoder.decode(bytes.get_data());

    let data = {};
    if (contents) {
        try {
            data = JSON.parse(contents);
        } catch (_error) {
            data = decodeForm(contents);
        }
    }

    const status = message.get_status();
    if (status >= 400 && !('error' in data)) {
        throw 'OAuthUnexpected';
    }

    return data;
}

function normalizeScopes(scopes) {
    if (!scopes) return '';
    if (Array.isArray(scopes)) return scopes.join(' ');
    return scopes;
}

function normalizeToken(config, token) {
    return {
        type: 'oauth',
        provider: config.provider,
        flow: config.flow,
        access_token: token.access_token,
        refresh_token: token.refresh_token || '',
        token_type: token.token_type || 'bearer',
        scope: token.scope || normalizeScopes(config.scopes),
        expires_in: Number(token.expires_in || 0),
        created_at: Math.floor(Date.now() / 1000),
    };
}

function randomString() {
    return (
        GLib.uuid_string_random().replaceAll('-', '') +
        GLib.uuid_string_random().replaceAll('-', '')
    );
}

export function isOAuthSecret(secret) {
    return (
        secret !== null &&
        typeof secret === 'object' &&
        secret.type === 'oauth' &&
        typeof secret.access_token === 'string'
    );
}

export function serializeSecret(secret) {
    if (isOAuthSecret(secret)) {
        return JSON.stringify(secret);
    }

    return secret;
}

export function parseSecret(secret) {
    if (typeof secret !== 'string' || !secret.startsWith('{')) {
        return {
            type: 'token',
            access_token: secret || '',
        };
    }

    try {
        const parsed = JSON.parse(secret);
        if (isOAuthSecret(parsed)) {
            return parsed;
        }
    } catch (_error) {
        // Fall through and treat malformed JSON secrets as legacy tokens.
    }

    return {
        type: 'token',
        access_token: secret || '',
    };
}

export async function startDeviceOAuth(config, onDeviceCode = null) {
    const device = await postForm(config.deviceCodeUrl, {
        client_id: config.clientId,
        scope: normalizeScopes(config.scopes),
    });

    if (!device.device_code) {
        throw device.error || 'OAuthUnexpected';
    }

    if (onDeviceCode !== null) {
        onDeviceCode(device);
    }

    let interval = Number(device.interval || config.interval || 5);
    const expiresAt = Date.now() + Number(device.expires_in || 900) * 1000;

    while (Date.now() < expiresAt) {
        await waitSeconds(interval);

        const token = await postForm(config.tokenUrl, {
            client_id: config.clientId,
            device_code: device.device_code,
            grant_type: DEVICE_GRANT,
        });

        if (token.access_token) {
            return normalizeToken(config, token);
        }

        switch (token.error) {
            case 'authorization_pending':
                break;
            case 'slow_down':
                interval = Number(token.interval || interval + 5);
                break;
            case 'expired_token':
            case 'token_expired':
                throw 'OAuthExpired';
            default:
                throw token.error || 'OAuthUnexpected';
        }
    }

    throw 'OAuthExpired';
}

export function createPkceRequest(config) {
    const verifier = randomString();
    const state = randomString();
    const challengeMethod = config.codeChallengeMethod || 'plain';
    const challenge = challengeMethod === 'plain' ? verifier : verifier;

    const authorizationUrl = buildURL(config.authorizeUrl, {
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: normalizeScopes(config.scopes),
        state: state,
        code_challenge: challenge,
        code_challenge_method: challengeMethod,
    });

    return {
        authorizationUrl: authorizationUrl,
        verifier: verifier,
        state: state,
    };
}

export function extractAuthorizationParams(value) {
    let query = value.trim();

    if (query.includes('?')) {
        query = query.split('?', 2)[1];
    }
    if (query.includes('#')) {
        query = query.split('#', 2)[0];
    }

    if (!query.includes('=')) {
        return {
            code: query,
            state: '',
        };
    }

    const params = decodeForm(query);
    return {
        code: params.code || '',
        state: params.state || '',
    };
}

export async function exchangeAuthorizationCode(config, request, codeOrUrl) {
    const params = extractAuthorizationParams(codeOrUrl);
    if (!params.code) {
        throw 'OAuthMissingCode';
    }

    if (request.state && params.state && request.state !== params.state) {
        throw 'OAuthStateMismatch';
    }

    const token = await postForm(config.tokenUrl, {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: config.redirectUri,
        code_verifier: request.verifier,
    });

    if (!token.access_token) {
        throw token.error || 'OAuthUnexpected';
    }

    return normalizeToken(config, token);
}

export function openOAuthURI(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, null);
    } catch (error) {
        console.error(error);
    }
}
