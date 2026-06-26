// SPDX-License-Identifier: BlueOak-1.0.0

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import { session } from './util.js';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const LOOPBACK_HOST = '127.0.0.1';
const LOOPBACK_PATH = '/oauth/callback';
const LOOPBACK_PORT = 15713;
const LOOPBACK_TIMEOUT_SECONDS = 300;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export const DEFAULT_LOOPBACK_REDIRECT_URI = `http://${LOOPBACK_HOST}:${LOOPBACK_PORT}${LOOPBACK_PATH}`;

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

function escapeHTML(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function writeCallbackResponse(message, title, description, error = false) {
    const body = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${escapeHTML(title)}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: system-ui, sans-serif;
      }
      body {
        display: grid;
        min-height: 100vh;
        margin: 0;
        place-items: center;
      }
      main {
        max-width: 36rem;
        padding: 2rem;
      }
      h1 {
        font-size: 1.5rem;
        margin: 0 0 0.75rem;
      }
      p {
        line-height: 1.5;
        margin: 0;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHTML(title)}</h1>
      <p>${escapeHTML(description)}</p>
    </main>
  </body>
</html>`;
    message.get_response_headers().set_content_type('text/html', null);
    message.get_response_body().append(body);
    message.set_status(error ? 400 : 200, null);
}

function loopbackRedirectUriFromServer(server) {
    const uris = server.get_uris();
    if (uris.length === 0) {
        return DEFAULT_LOOPBACK_REDIRECT_URI;
    }

    const port = uris[0].get_port();
    return `http://${LOOPBACK_HOST}:${port}${LOOPBACK_PATH}`;
}

export function startOAuthLoopbackCallback({
    port = LOOPBACK_PORT,
    timeoutSeconds = LOOPBACK_TIMEOUT_SECONDS,
    allowPortFallback = true,
} = {}) {
    const server = new Soup.Server();
    let settled = false;
    let timeoutId = 0;
    let resolveCallback;
    let rejectCallback;

    const promise = new Promise((resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = reject;
    });

    const cleanup = () => {
        if (timeoutId !== 0) {
            GLib.Source.remove(timeoutId);
            timeoutId = 0;
        }

        try {
            server.disconnect();
        } catch (_error) {
            // The server may already be disconnected after a terminal callback.
        }
    };

    const settle = (callback, value) => {
        if (settled) {
            return;
        }

        settled = true;
        if (timeoutId !== 0) {
            GLib.Source.remove(timeoutId);
            timeoutId = 0;
        }
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            cleanup();
            return GLib.SOURCE_REMOVE;
        });
        callback(value);
    };

    let redirectUri = DEFAULT_LOOPBACK_REDIRECT_URI;

    server.add_handler(LOOPBACK_PATH, (_server, message) => {
        const query = message.get_uri().get_query() || '';
        const callbackUri = query ? `${redirectUri}?${query}` : redirectUri;
        const params = decodeForm(query);

        if (params.error) {
            writeCallbackResponse(
                message,
                'Cinders received an OAuth error',
                'Return to Cinders for details.',
                true,
            );
            settle(rejectCallback, {
                code: params.error,
                detail: params.error_description || params.error,
            });
            return;
        }

        writeCallbackResponse(
            message,
            'Cinders received the authorization response',
            'You can return to Cinders to finish signing in.',
        );
        settle(resolveCallback, callbackUri);
    });

    try {
        server.listen(
            Gio.InetSocketAddress.new_from_string(LOOPBACK_HOST, port),
            null,
        );
    } catch (_error) {
        if (!allowPortFallback) {
            cleanup();
            throw _error;
        }

        try {
            server.listen(
                Gio.InetSocketAddress.new_from_string(LOOPBACK_HOST, 0),
                null,
            );
        } catch (fallbackError) {
            cleanup();
            throw fallbackError;
        }
    }

    redirectUri = loopbackRedirectUriFromServer(server);
    timeoutId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        timeoutSeconds,
        () => {
            timeoutId = 0;
            settle(rejectCallback, 'OAuthExpired');
            return GLib.SOURCE_REMOVE;
        },
    );

    return {
        redirectUri,
        promise,
        stop() {
            settle(rejectCallback, 'OAuthCallbackStopped');
        },
    };
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
    const createdAt = Number(token.created_at || Math.floor(Date.now() / 1000));
    const expiresIn = Number(token.expires_in || 0);

    return {
        type: 'oauth',
        provider: config.provider,
        flow: config.flow,
        access_token: token.access_token,
        refresh_token: token.refresh_token || '',
        token_type: token.token_type || 'bearer',
        scope: token.scope || normalizeScopes(config.scopes),
        expires_in: expiresIn,
        created_at: createdAt,
        expires_at: expiresIn
            ? new Date((createdAt + expiresIn) * 1000).toISOString()
            : '',
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

export async function startDeviceOAuth(config, callbacks = null) {
    const onDeviceCode =
        typeof callbacks === 'function'
            ? callbacks
            : callbacks?.onDeviceCode || null;
    const onPoll =
        typeof callbacks === 'object' ? callbacks?.onPoll || null : null;
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
    let attempt = 0;

    while (Date.now() < expiresAt) {
        if (onPoll !== null) {
            onPoll({
                state: 'waiting',
                attempt: attempt,
                interval: interval,
                expiresAt: expiresAt,
            });
        }
        await waitSeconds(interval);
        attempt += 1;

        if (onPoll !== null) {
            onPoll({
                state: 'checking',
                attempt: attempt,
                interval: interval,
                expiresAt: expiresAt,
            });
        }

        const token = await postForm(config.tokenUrl, {
            client_id: config.clientId,
            device_code: device.device_code,
            grant_type: DEVICE_GRANT,
        });

        if (token.access_token) {
            if (onPoll !== null) {
                onPoll({
                    state: 'authorized',
                    attempt: attempt,
                    interval: interval,
                    expiresAt: expiresAt,
                });
            }
            return normalizeToken(config, token);
        }

        switch (token.error) {
            case 'authorization_pending':
                if (onPoll !== null) {
                    onPoll({
                        state: 'pending',
                        attempt: attempt,
                        interval: interval,
                        expiresAt: expiresAt,
                    });
                }
                break;
            case 'slow_down':
                interval = Number(token.interval || interval + 5);
                if (onPoll !== null) {
                    onPoll({
                        state: 'slow_down',
                        attempt: attempt,
                        interval: interval,
                        expiresAt: expiresAt,
                    });
                }
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
        redirectUri: config.redirectUri,
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
        redirect_uri: request.redirectUri || config.redirectUri,
        code_verifier: request.verifier,
    });

    if (!token.access_token) {
        throw token.error || 'OAuthUnexpected';
    }

    return normalizeToken(config, token);
}

export function tokenExpiresSoon(tokenPayload, thresholdSeconds = 120) {
    const expiresIn = Number(tokenPayload?.expires_in || 0);
    if (!expiresIn) {
        return false;
    }

    const createdAt = Number(tokenPayload?.created_at || 0);
    if (!createdAt) {
        return false;
    }

    const secondsRemaining =
        createdAt + expiresIn - Math.floor(Date.now() / 1000);
    return secondsRemaining < thresholdSeconds;
}

export async function refreshOAuthToken(config, tokenPayload) {
    if (!tokenPayload?.refresh_token) {
        throw 'OAuthExpired';
    }

    const token = await postForm(config.tokenUrl, {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: tokenPayload.refresh_token,
        redirect_uri: config.redirectUri,
    });

    if (!token.access_token) {
        throw token.error || 'OAuthUnexpected';
    }

    const refreshed = normalizeToken(config, token);
    if (!refreshed.refresh_token) {
        refreshed.refresh_token = tokenPayload.refresh_token;
    }

    return refreshed;
}

export function openOAuthURI(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, null);
    } catch (error) {
        console.error(error);
    }
}
