// SPDX-License-Identifier: MIT

import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import { gettext as _ } from 'gettext';

import Forge from './forge.js';
import Notification from '../model/notification.js';
import { session } from './../util.js';

export default class Tangled extends Forge {
    static name = 'tangled';

    static prettyName = 'Tangled';

    static allowInstances = true;

    static defaultURL = 'tangled.org';

    static authMethods = ['token', 'oauth'];

    static scopes = ['atproto'];

    static oauthConfig(url) {
        return {
            provider: this.name,
            flow: 'pkce',
            clientId:
                'https://yulian.dev/cinders/oauth/client-metadata.json',
            scopes: this.scopes,
            authorizeUrl: `https://${url}/oauth/authorize`,
            tokenUrl: `https://${url}/oauth/token`,
            redirectUri: 'http://127.0.0.1/oauth/callback',
            codeChallengeMethod: 'plain',
        };
    }

    static get tokenText() {
        let tokenText = _(
            'Tangled support currently reads the web notification fragment.',
        );
        tokenText += '\n\n';
        tokenText += _(
            'For token mode, paste a session cookie prefixed with <i>cookie:</i>. OAuth is scaffolded with placeholder AT Protocol client metadata until real app registration values are available.',
        );

        return tokenText;
    }

    get authorization() {
        return 'Bearer ' + this.token;
    }

    createMessage(method, url, data = null, headers = {}) {
        const message = Soup.Message.new(method, url);

        if (data !== null) {
            data = JSON.stringify(data);
            const bytes = this.encoder.encode(data);
            message.set_request_body_from_bytes(
                'application/json',
                new GLib.Bytes(bytes),
            );
        }

        Object.entries(headers).forEach(([key, value]) => {
            message.request_headers.append(key, value);
        });

        if (this.token.startsWith('cookie:')) {
            message.request_headers.append('Cookie', this.token.slice(7));
        } else {
            message.request_headers.append('Authorization', this.authorization);
        }
        message.request_headers.append('Time-Zone', 'UTC');

        return message;
    }

    async getUser() {
        try {
            const url = this.buildURI('notifications/count');
            const message = this.createMessage('GET', url);
            await session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
            );

            if (
                message.get_status() === 401 ||
                message.get_status() === 403
            ) {
                throw 'FailedForgeAuth';
            } else if (message.get_status() >= 400) {
                throw 'Unexpected';
            }

            return [0, this.accountName || this.url];
        } catch (error) {
            throw error;
        }
    }

    async getNotifications() {
        try {
            const url = this.buildURI('notifications/preview', {
                read: 'unread',
            });
            const message = this.createMessage('GET', url);
            const bytes = await session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
            );

            if (
                message.get_status() === 401 ||
                message.get_status() === 403
            ) {
                throw 'FailedForgeAuth';
            } else if (message.get_status() >= 400) {
                throw 'Unexpected';
            }

            const contents = this.decoder.decode(bytes.get_data());
            return this._readNotifications(contents);
        } catch (error) {
            throw error;
        }
    }

    async markAsRead(id = null) {
        try {
            const path =
                id === null
                    ? 'notifications/read-all'
                    : `notifications/${id}/read`;
            const url = this.buildURI(path);
            const message = this.createMessage('POST', url);
            await session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
            );

            return (
                message.get_status() === 200 || message.get_status() === 204
            );
        } catch (error) {
            throw error;
        }
    }

    buildURI(path, query = {}) {
        return Forge.buildURI(this.url, path, query);
    }

    _readNotifications(html) {
        const notifications = [];
        const updatedAt = GLib.DateTime.new_now_utc().format_iso8601();

        for (const block of html.split('<a ')) {
            const idMatch = block.match(/\/notifications\/(\d+)\/read/);
            if (idMatch === null) {
                continue;
            }

            const href = this._match(block, /href="([^"]*)"/);
            const repository = this._repositoryFromPath(href);
            if (this.isRepositoryExcluded(repository)) {
                continue;
            }

            const title = this._titleFromBlock(block);
            const notification = new Notification({
                id: this.formatID(idMatch[1]),
                type: this._typeFromBlock(block, href),
                unread: true,
                updatedAt: updatedAt,
                title: title,
                repository: repository,
                url: this._absoluteURL(href),
                account_name: this.accountName,
            });
            notifications.push(notification);
        }

        return notifications;
    }

    _match(text, pattern) {
        const match = text.match(pattern);
        return match === null ? '' : match[1];
    }

    _titleFromBlock(block) {
        const summary = this._match(
            block,
            /row-start-2 col-start-2[^>]*>([\s\S]*?)<\/div>/,
        );
        if (summary) {
            return this._stripHTML(summary);
        }

        return (
            this._stripHTML(
                this._match(
                    block,
                    /row-start-1 flex items-center[^>]*>([\s\S]*?)<\/div>/,
                ),
            ) || _('Tangled notification')
        );
    }

    _typeFromBlock(block, href) {
        if (href.includes('/pulls/')) {
            return 'PullRequest';
        } else if (href.includes('/issues/')) {
            return 'Issue';
        } else if (block.includes('repo_starred') || block.includes('starred')) {
            return 'Repository';
        }

        return 'Discussion';
    }

    _repositoryFromPath(href) {
        const path = href.replace(/^https?:\/\/[^/]+/, '');
        const parts = path.replace(/^\/+/, '').split('/');
        if (parts.length >= 2 && parts[0] !== 'notifications') {
            return `${parts[0]}/${parts[1]}`;
        }

        return 'Tangled';
    }

    _absoluteURL(href) {
        if (/^https?:\/\//i.test(href)) {
            return href;
        }

        return `https://${this.url}${href}`;
    }

    _stripHTML(html) {
        return html
            .replace(/<[^>]*>/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim();
    }
}
