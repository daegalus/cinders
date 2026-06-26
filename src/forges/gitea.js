// SPDX-License-Identifier: BlueOak-1.0.0

import GLib from 'gi://GLib';
import { gettext as _ } from 'gettext';

import Forge from './forge.js';
import GitHub from './github.js';
import AccountsManager from '../model/accountsManager.js';
import {
    DEFAULT_LOOPBACK_REDIRECT_URI,
    refreshOAuthToken,
    tokenExpiresSoon,
} from '../oauth.js';
import { session } from './../util.js';

const accounts = new AccountsManager();

/**
 * Gitea implementation
 *
 * Gitea has a GitHub compatible API, so we can basically just derive from our
 * GitHub class and tweak some methods.
 */
export default class Gitea extends GitHub {
    static name = 'gitea';

    static prettyName = 'Gitea';

    static allowInstances = true;

    static defaultURL = 'gitea.com';

    static scopes = ['read:issue', 'write:notification', 'read:user'];

    static authMethods = ['token', 'oauth'];

    static oauthConfig(url) {
        return {
            provider: this.name,
            flow: 'pkce',
            clientId: 'FORGE_SPARKS_GITEA_CLIENT_ID',
            scopes: this.scopes,
            authorizeUrl: `https://${url}/login/oauth/authorize`,
            tokenUrl: `https://${url}/login/oauth/access_token`,
            redirectUri: DEFAULT_LOOPBACK_REDIRECT_URI,
            codeChallengeMethod: 'plain',
        };
    }

    static get tokenText() {
        /* Gitea access token help */
        let tokenText = _(
            'To generate a new access token from your instance, go to Settings → Applications and generate a new token.',
        );
        tokenText += '\n\n';
        /* Gitea access token help */
        tokenText += _(
            'Cinders requires the <i>read:issue</i>, <i>write:notification</i> and <i>read:user</i> scopes granted.',
        );

        return tokenText;
    }

    async _refreshOAuthTokenIfNeeded() {
        if (
            this.authMethod !== 'oauth' ||
            !this.tokenPayload?.refresh_token ||
            !tokenExpiresSoon(this.tokenPayload)
        ) {
            return;
        }

        const refreshed = await refreshOAuthToken(
            this.constructor.oauthConfig(this.url),
            this.tokenPayload,
        );
        this.tokenPayload = refreshed;
        this.token = refreshed.access_token;

        if (this.account !== null) {
            await accounts.updateAccountSecret(
                this.account,
                this.url,
                refreshed,
            );
        }
    }

    async createMessage(method, url, data = null, headers = {}) {
        await this._refreshOAuthTokenIfNeeded();
        return super.createMessage(method, url, data, headers);
    }

    async markAsRead(id = null) {
        /**
         * Gitea differs from GitHub's markAsRead, params are url queries
         */
        try {
            if (id !== null) {
                const url = this.buildURI(`/notifications/threads/${id}`);
                const message = await this.createMessage('PATCH', url);
                await session.send_and_read_async(
                    message,
                    GLib.PRIORITY_DEFAULT,
                    null,
                );

                /* If Reset-Content */
                return message.get_status() === 205;
            } else {
                const now = GLib.DateTime.new_now_utc();
                const url = this.buildURI('notifications', {
                    last_read_at: now.format_iso8601(),
                    all: true,
                });
                const message = await this.createMessage('PUT', url);
                await session.send_and_read_async(
                    message,
                    GLib.PRIORITY_DEFAULT,
                    null,
                );

                /* If Reset-Content */
                return message.get_status() === 205;
            }
        } catch (e) {
            throw e;
        }
    }

    /**
     * Build a request URI from multiple parts
     *
     * This is a simplified version of Forge.buildURI with passed instance url
     * set as host and api v1 prepended to path
     *
     * @param {string} path The URI path
     * @param {Object.<string, string>} query The URI query
     * @returns {string} The resulting URI
     */
    buildURI(path, query = {}) {
        return Forge.buildURI(this.url, '/api/v1/' + path, query);
    }
}
