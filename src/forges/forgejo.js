// SPDX-License-Identifier: BlueOak-1.0.0

import GLib from 'gi://GLib';
import { gettext as _ } from 'gettext';

import Forge from './forge.js';
import Gitea from './gitea.js';

/**
 * Forgejo implementation
 *
 * Forgejo and Gitea have compatible API, so we can basically just derive from
 * our Gitea class.
 *
 * We keep them separate just in case things change in the future.
 */
export default class Forgejo extends Gitea {
    static name = 'forgejo';

    static prettyName = 'Forgejo';

    static allowInstances = true;

    static defaultURL = 'codeberg.org';

    static codebergClientId = '645e2e14-fd3c-4ec0-9c08-f043561eb843';

    static oauthConfig(url) {
        const clientId =
            url === this.defaultURL
                ? this.codebergClientId
                : 'FORGE_SPARKS_FORGEJO_CLIENT_ID';

        return {
            ...super.oauthConfig(url),
            provider: this.name,
            clientId: clientId,
        };
    }
}
