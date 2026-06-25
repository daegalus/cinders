// SPDX-License-Identifier: MIT

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import { extractAuthorizationParams } from './oauth.js';
import { session } from './util.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

const DEFAULT_HANDLE_RESOLVER =
    'https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle';

const P256 = {
    p: BigInt(
        '0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff',
    ),
    n: BigInt(
        '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
    ),
    a: -3n,
    gx: BigInt(
        '0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296',
    ),
    gy: BigInt(
        '0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5',
    ),
};

function encodeFormComponent(value) {
    return GLib.uri_escape_string(String(value), null, false).replaceAll(
        '%20',
        '+',
    );
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

function buildURL(url, params) {
    const separator = url.includes('?') ? '&' : '?';
    const query = encodeForm(params);
    return query ? `${url}${separator}${query}` : url;
}

function parseUri(url) {
    return GLib.Uri.parse(url, GLib.UriFlags.NONE);
}

function uriHost(url) {
    return parseUri(url).get_host();
}

function uriOrigin(url) {
    const uri = parseUri(url);
    const port = uri.get_port();
    const portPart = port > 0 ? `:${port}` : '';
    return `${uri.get_scheme()}://${uri.get_host()}${portPart}`;
}

function normalizeScopes(scopes) {
    if (!scopes) return '';
    if (Array.isArray(scopes)) return scopes.join(' ');
    return scopes;
}

function normalizeLoginHint(loginHint) {
    const value = String(loginHint || '').trim();
    if (/^https?:\/\//i.test(value)) {
        return value;
    }

    return value.startsWith('@') ? value.slice(1) : value;
}

function oauthError(code, detail = '') {
    return { code, detail };
}

function responseError(response) {
    const detail =
        response.data.message ||
        response.data.error_description ||
        response.body?.trim() ||
        `HTTP ${response.status}`;
    return oauthError(response.data.error || 'OAuthUnexpected', detail);
}

function bytesToBase64Url(bytes) {
    return GLib.base64_encode(bytes)
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
}

function stringToBase64Url(value) {
    return bytesToBase64Url(encoder.encode(value));
}

function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

function sha256Bytes(value) {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    const digest = GLib.compute_checksum_for_bytes(
        GLib.ChecksumType.SHA256,
        new GLib.Bytes(bytes),
    );
    return hexToBytes(digest);
}

function sha256Base64Url(value) {
    return bytesToBase64Url(sha256Bytes(value));
}

function randomBytes(length) {
    const file = Gio.File.new_for_path('/dev/urandom');
    const stream = file.read(null);
    try {
        const bytes = stream.read_bytes(length, null);
        return new Uint8Array(bytes.get_data());
    } finally {
        stream.close(null);
    }
}

function randomBase64Url(length = 32) {
    return bytesToBase64Url(randomBytes(length));
}

function bigIntFromBytes(bytes) {
    let hex = '';
    for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, '0');
    }
    return BigInt('0x' + hex);
}

function bigIntToBytes(value, length = 32) {
    let hex = value.toString(16);
    if (hex.length > length * 2) {
        throw new Error('Integer is too large');
    }
    hex = hex.padStart(length * 2, '0');
    return hexToBytes(hex);
}

function randomScalar() {
    while (true) {
        const value = bigIntFromBytes(randomBytes(32));
        if (value > 0n && value < P256.n) {
            return value;
        }
    }
}

function mod(value, modulus) {
    const result = value % modulus;
    return result >= 0n ? result : result + modulus;
}

function modInv(value, modulus) {
    let a = mod(value, modulus);
    let b = modulus;
    let x = 0n;
    let y = 1n;
    let u = 1n;
    let v = 0n;

    while (a !== 0n) {
        const q = b / a;
        const r = b % a;
        const m = x - u * q;
        const n = y - v * q;
        b = a;
        a = r;
        x = u;
        y = v;
        u = m;
        v = n;
    }

    if (b !== 1n) {
        throw new Error('No modular inverse');
    }

    return mod(x, modulus);
}

function pointAdd(left, right) {
    if (left === null) return right;
    if (right === null) return left;

    if (left.x === right.x) {
        if (mod(left.y + right.y, P256.p) === 0n) {
            return null;
        }

        const numerator = mod(3n * left.x * left.x + P256.a, P256.p);
        const denominator = modInv(2n * left.y, P256.p);
        const slope = mod(numerator * denominator, P256.p);
        const x = mod(slope * slope - left.x - right.x, P256.p);
        const y = mod(slope * (left.x - x) - left.y, P256.p);
        return { x, y };
    }

    const numerator = mod(right.y - left.y, P256.p);
    const denominator = modInv(right.x - left.x, P256.p);
    const slope = mod(numerator * denominator, P256.p);
    const x = mod(slope * slope - left.x - right.x, P256.p);
    const y = mod(slope * (left.x - x) - left.y, P256.p);
    return { x, y };
}

function scalarMultiply(scalar, point = { x: P256.gx, y: P256.gy }) {
    let addend = point;
    let result = null;
    let value = scalar;

    while (value > 0n) {
        if ((value & 1n) === 1n) {
            result = pointAdd(result, addend);
        }
        addend = pointAdd(addend, addend);
        value >>= 1n;
    }

    return result;
}

function createDpopKey() {
    const d = randomScalar();
    const point = scalarMultiply(d);
    return {
        kty: 'EC',
        crv: 'P-256',
        alg: 'ES256',
        d: bytesToBase64Url(bigIntToBytes(d)),
        x: bytesToBase64Url(bigIntToBytes(point.x)),
        y: bytesToBase64Url(bigIntToBytes(point.y)),
    };
}

function base64UrlToBigInt(value) {
    let base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    while (base64.length % 4 !== 0) {
        base64 += '=';
    }

    return bigIntFromBytes(GLib.base64_decode(base64));
}

function publicJwk(key) {
    return {
        kty: key.kty,
        crv: key.crv,
        x: key.x,
        y: key.y,
    };
}

function signJwt(header, payload, key) {
    const signingInput =
        stringToBase64Url(JSON.stringify(header)) +
        '.' +
        stringToBase64Url(JSON.stringify(payload));
    const z = bigIntFromBytes(sha256Bytes(signingInput));
    const d = base64UrlToBigInt(key.d);

    while (true) {
        const k = randomScalar();
        const point = scalarMultiply(k);
        if (point === null) continue;

        const r = mod(point.x, P256.n);
        if (r === 0n) continue;

        let s = mod(modInv(k, P256.n) * (z + r * d), P256.n);
        if (s === 0n) continue;
        if (s > P256.n / 2n) {
            s = P256.n - s;
        }

        const signature = new Uint8Array(64);
        signature.set(bigIntToBytes(r), 0);
        signature.set(bigIntToBytes(s), 32);
        return `${signingInput}.${bytesToBase64Url(signature)}`;
    }
}

export function createDpopProof(
    method,
    url,
    key,
    accessToken = '',
    nonce = '',
) {
    const payload = {
        htm: method.toUpperCase(),
        htu: url.split('#', 1)[0],
        iat: Math.floor(Date.now() / 1000),
        jti: randomBase64Url(16),
    };

    if (accessToken) {
        payload.ath = sha256Base64Url(accessToken);
    }
    if (nonce) {
        payload.nonce = nonce;
    }

    return signJwt(
        {
            typ: 'dpop+jwt',
            alg: 'ES256',
            jwk: publicJwk(key),
        },
        payload,
        key,
    );
}

function createMessage(method, url, data = null, headers = {}) {
    const message = Soup.Message.new(method, url);

    Object.entries(headers).forEach(([key, value]) => {
        message.request_headers.append(key, value);
    });

    if (data !== null) {
        const body = typeof data === 'string' ? data : JSON.stringify(data);
        message.set_request_body_from_bytes(
            headers['Content-Type'] || 'application/json',
            new GLib.Bytes(encoder.encode(body)),
        );
    }

    return message;
}

async function readMessage(message) {
    const bytes = await session.send_and_read_async(
        message,
        GLib.PRIORITY_DEFAULT,
        null,
    );
    const body = decoder.decode(bytes.get_data());
    let data = {};

    if (body) {
        try {
            data = JSON.parse(body);
        } catch (_error) {
            data = {};
        }
    }

    return {
        data,
        body,
        status: message.get_status(),
        dpopNonce: message.response_headers.get_one('DPoP-Nonce') || '',
    };
}

async function send(message) {
    const response = await readMessage(message);
    if (response.status >= 400) {
        throw responseError(response);
    }

    return response.data;
}

async function getJson(url) {
    const message = createMessage('GET', url, null, {
        Accept: 'application/json',
    });
    return send(message);
}

async function postForm(url, params, dpopKey) {
    const body = encodeForm(params);
    let nonce = '';

    for (let attempt = 0; attempt < 2; attempt++) {
        const message = createMessage('POST', url, body, {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            DPoP: createDpopProof('POST', url, dpopKey, '', nonce),
        });
        const response = await readMessage(message);

        if (response.status < 400) {
            return response.data;
        }

        if (
            attempt === 0 &&
            response.dpopNonce &&
            response.data.error === 'use_dpop_nonce'
        ) {
            nonce = response.dpopNonce;
            continue;
        }

        throw responseError(response);
    }

    throw oauthError('OAuthUnexpected');
}

function metadataUrl(origin, name) {
    return `https://${origin}/.well-known/${name}`;
}

async function resolveAuthorizationServerMetadata(issuer) {
    const metadata = await getJson(
        metadataUrl(uriHost(issuer), 'oauth-authorization-server'),
    );
    if (metadata.issuer !== issuer) {
        throw 'OAuthIssuerMismatch';
    }
    if (metadata.client_id_metadata_document_supported !== true) {
        throw 'OAuthUnsupported';
    }
    return metadata;
}

async function resolveResourceServerMetadata(resource) {
    const origin = uriOrigin(resource);
    const metadata = await getJson(
        metadataUrl(uriHost(resource), 'oauth-protected-resource'),
    );
    if (metadata.resource && metadata.resource !== origin) {
        throw 'OAuthIssuerMismatch';
    }
    if (
        !Array.isArray(metadata.authorization_servers) ||
        metadata.authorization_servers.length !== 1
    ) {
        throw 'OAuthUnsupported';
    }

    const issuer = metadata.authorization_servers[0];
    return resolveAuthorizationServerMetadata(issuer);
}

async function resolveDidDocument(did) {
    if (did.startsWith('did:plc:')) {
        return getJson(`https://plc.directory/${did}`);
    }

    if (did.startsWith('did:web:')) {
        const parts = did
            .slice(8)
            .split(':')
            .map((part) => decodeURIComponent(part));
        const host = parts.shift();
        const path =
            parts.length === 0
                ? '/.well-known/did.json'
                : `/${parts.join('/')}/did.json`;
        return getJson(`https://${host}${path}`);
    }

    throw 'OAuthUnsupported';
}

function extractPdsUrl(didDocument) {
    const services = Array.isArray(didDocument.service)
        ? didDocument.service
        : [];
    const service = services.find(
        (entry) =>
            entry.id === '#atproto_pds' ||
            entry.type === 'AtprotoPersonalDataServer',
    );

    if (!service || typeof service.serviceEndpoint !== 'string') {
        throw 'OAuthUnsupported';
    }

    return service.serviceEndpoint;
}

async function resolveHandle(handle, resolverUrl = DEFAULT_HANDLE_RESOLVER) {
    const data = await getJson(
        buildURL(resolverUrl, {
            handle,
        }),
    );

    if (!data.did) {
        throw oauthError('OAuthHandleResolutionFailed');
    }

    return data.did;
}

async function resolveIdentity(input, resolverUrl = DEFAULT_HANDLE_RESOLVER) {
    const did = input.startsWith('did:')
        ? input
        : await resolveHandle(input, resolverUrl);
    const didDocument = await resolveDidDocument(did);

    return {
        did,
        handle: input.startsWith('did:') ? did : input,
        pds: extractPdsUrl(didDocument),
    };
}

async function resolveOAuth(input, resolverUrl = DEFAULT_HANDLE_RESOLVER) {
    if (/^https?:\/\//.test(input)) {
        return {
            metadata: await resolveResourceServerMetadata(input),
        };
    }

    const identity = await resolveIdentity(input, resolverUrl);
    const metadata = await resolveResourceServerMetadata(identity.pds);
    return {
        identity,
        metadata,
    };
}

function negotiatePublicClient(metadata) {
    if (
        Array.isArray(metadata.token_endpoint_auth_methods_supported) &&
        !metadata.token_endpoint_auth_methods_supported.includes('none')
    ) {
        throw 'OAuthUnsupported';
    }
}

function createPkce() {
    const verifier = randomBase64Url(32);
    return {
        verifier,
        challenge: sha256Base64Url(verifier),
        method: 'S256',
    };
}

export async function startAtprotoOAuth(config, loginHint) {
    const input = normalizeLoginHint(loginHint);
    if (!input) {
        throw oauthError('OAuthMissingLoginHint');
    }

    const { identity, metadata } = await resolveOAuth(
        input,
        config.handleResolverUrl,
    );
    negotiatePublicClient(metadata);

    const pkce = createPkce();
    const dpopKey = createDpopKey();
    const state = randomBase64Url(32);
    const scope = normalizeScopes(config.scopes);
    const parameters = {
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        code_challenge: pkce.challenge,
        code_challenge_method: pkce.method,
        state,
        login_hint: identity?.handle,
        response_type: 'code',
        response_mode: 'query',
        scope,
    };

    const authorizationUrl = metadata.authorization_endpoint;
    if (!authorizationUrl) {
        throw 'OAuthUnsupported';
    }

    let browserUrl;
    if (metadata.pushed_authorization_request_endpoint) {
        const parResponse = await postForm(
            metadata.pushed_authorization_request_endpoint,
            parameters,
            dpopKey,
        );
        if (!parResponse.request_uri) {
            throw 'OAuthUnexpected';
        }
        browserUrl = buildURL(authorizationUrl, {
            client_id: config.clientId,
            request_uri: parResponse.request_uri,
        });
    } else if (metadata.require_pushed_authorization_requests) {
        throw 'OAuthUnsupported';
    } else {
        browserUrl = buildURL(authorizationUrl, parameters);
    }

    return {
        authorizationUrl: browserUrl,
        verifier: pkce.verifier,
        state,
        issuer: metadata.issuer,
        metadata,
        identity,
        dpopKey,
    };
}

function normalizeToken(config, request, token, aud) {
    const createdAt = Math.floor(Date.now() / 1000);
    const expiresIn = Number(token.expires_in || 0);

    return {
        type: 'oauth',
        provider: config.provider,
        flow: 'atproto',
        access_token: token.access_token,
        refresh_token: token.refresh_token || '',
        token_type: token.token_type || 'DPoP',
        scope: token.scope || normalizeScopes(config.scopes),
        expires_in: expiresIn,
        created_at: createdAt,
        expires_at: expiresIn
            ? new Date((createdAt + expiresIn) * 1000).toISOString()
            : '',
        sub: token.sub || request.identity?.did || '',
        iss: request.metadata.issuer,
        aud,
        atproto: {
            client_id: config.clientId,
            redirect_uri: config.redirectUri,
            dpop_key: request.dpopKey,
            server: request.metadata,
            identity: request.identity || null,
        },
    };
}

async function exchangeToken(config, request, code) {
    if (!request.metadata.token_endpoint) {
        throw 'OAuthUnsupported';
    }

    return postForm(
        request.metadata.token_endpoint,
        {
            grant_type: 'authorization_code',
            client_id: config.clientId,
            redirect_uri: config.redirectUri,
            code,
            code_verifier: request.verifier,
        },
        request.dpopKey,
    );
}

async function verifyIssuer(
    sub,
    issuer,
    resolverUrl = DEFAULT_HANDLE_RESOLVER,
) {
    const identity = await resolveIdentity(sub, resolverUrl);
    const metadata = await resolveResourceServerMetadata(identity.pds);

    if (metadata.issuer !== issuer) {
        throw 'OAuthIssuerMismatch';
    }

    return identity.pds;
}

export async function exchangeAtprotoAuthorizationCode(
    config,
    request,
    codeOrUrl,
) {
    const params = extractAuthorizationParams(codeOrUrl);
    if (!params.code) {
        throw 'OAuthMissingCode';
    }

    if (request.state && params.state && request.state !== params.state) {
        throw 'OAuthStateMismatch';
    }

    if (params.iss && params.iss !== request.metadata.issuer) {
        throw 'OAuthIssuerMismatch';
    }

    const token = await exchangeToken(config, request, params.code);
    if (!token.access_token || !token.sub) {
        throw 'OAuthUnexpected';
    }

    const aud = await verifyIssuer(
        token.sub,
        request.metadata.issuer,
        config.handleResolverUrl,
    );
    return normalizeToken(config, request, token, aud);
}

export async function refreshAtprotoOAuthToken(tokenPayload) {
    const atproto = tokenPayload?.atproto;
    if (!atproto?.dpop_key || !tokenPayload?.refresh_token) {
        throw 'OAuthExpired';
    }

    const server =
        atproto.server ||
        (await resolveAuthorizationServerMetadata(tokenPayload.iss));
    const token = await postForm(
        server.token_endpoint,
        {
            grant_type: 'refresh_token',
            client_id: atproto.client_id,
            refresh_token: tokenPayload.refresh_token,
        },
        atproto.dpop_key,
    );

    if (!token.access_token) {
        throw 'OAuthUnexpected';
    }

    const request = {
        metadata: server,
        identity: atproto.identity,
        dpopKey: atproto.dpop_key,
    };
    const aud = await verifyIssuer(tokenPayload.sub, server.issuer);
    return normalizeToken(
        {
            provider: tokenPayload.provider,
            flow: 'atproto',
            clientId: atproto.client_id,
            redirectUri: atproto.redirect_uri,
            scopes: tokenPayload.scope,
        },
        request,
        {
            ...token,
            sub: tokenPayload.sub,
        },
        aud,
    );
}
