import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import { gettext as _ } from 'gettext';

import { FORGES } from '../forges/index.js';
import AccountsManager from '../model/accountsManager.js';
import {
    createPkceRequest,
    exchangeAuthorizationCode,
    openOAuthURI,
    startDeviceOAuth,
} from '../oauth.js';
import {
    exchangeAtprotoAuthorizationCode,
    startAtprotoOAuth,
} from '../atprotoOAuth.js';
import {
    joinRepositoryFilters,
    splitRepositoryFilters,
    validateRepositoryFilters,
} from '../model/repositoryFilter.js';

import Template from './accountDialog.blp' with { type: 'uri' };

const accounts = new AccountsManager();

export default class AccountDialog extends Adw.Dialog {
    static {
        GObject.registerClass(
            {
                Template,
                InternalChildren: [
                    'forge',
                    'instance',
                    'authMethod',
                    'oauthStatusRow',
                    'oauthLogin',
                    'oauthStatus',
                    'oauthDeviceCode',
                    'oauthDeviceUri',
                    'oauthDeviceActions',
                    'oauthCopyDeviceCode',
                    'oauthOpenDeviceUri',
                    'oauthLoginHint',
                    'oauthCode',
                    'oauthExchange',
                    'accessToken',
                    'accessTokenHelp',
                    'excludedRepositories',
                    'removeAccount',
                    'saveBtn',
                    'toasts',
                    'page',
                    'titleWidget',
                ],
                Properties: {
                    editing: GObject.ParamSpec.boolean(
                        'editing',
                        null,
                        null,
                        GObject.ParamFlags.READWRITE,
                        null,
                    ),
                },
            },
            this,
        );
    }

    /**
     * Crete an AccountDialog
     */
    constructor(account = null, constructProperties = {}) {
        super(constructProperties);

        this._forges_ls = Object.values(FORGES);
        this._account = null;
        this._editing = false;
        this._userChangedInstance = false;
        this._savedExcludedRepositories = [];
        this._savedAuthMethod = 'token';
        this._oauthTokenPayload = null;
        this._oauthRequest = null;
        this._oauthBusy = false;

        this.connect('notify::editing', this._onEditing.bind(this));

        /* Populate forges list (Create account view) */
        const forgesList = new Gtk.StringList();
        for (const forge of this._forges_ls) {
            forgesList.append(forge.prettyName);
        }
        this._forge.model = forgesList;

        /* Populate auth method list */
        const authMethods = new Gtk.StringList();
        authMethods.append(_('Access Token'));
        authMethods.append(_('OAuth'));
        this._authMethod.model = authMethods;

        /* Setup edited account */
        if (account !== null) {
            this._account = account;
            this._editing = true;
            this.notify('editing');

            this._loadSavedAccount();
        } else {
            this._onForgeChanged();
        }
    }

    /**
     * If the form is editing an existing account
     *
     * @type {boolean}
     */
    get editing() {
        return this._editing;
    }

    /**
     * Change labels to the editing context
     */
    _onEditing() {
        if (this.editing) {
            this.title = _('Edit Account');
            this._saveBtn.label = _('Save');

            if (this._account !== null)
                this._titleWidget.subtitle = this._account.displayName;
        }
    }

    /**
     * Load the account saved values
     */
    async _loadSavedAccount() {
        /* Load saved instance URL */
        if (this._allowInstances()) {
            this._instance.visible = true;
            this._instance.text = this._account.url;
        }

        /* Load saved token */
        const tokenPayload = await accounts.getAccountTokenPayload(
            this._account.id,
        );
        const token = tokenPayload.access_token;
        const authMethod = accounts.getAccountAuthMethod(this._account.id);
        this._savedAuthMethod = authMethod;
        this._oauthTokenPayload =
            authMethod === 'oauth' ? tokenPayload : null;
        this._authMethod.selected = authMethod === 'oauth' ? 1 : 0;
        this._accessToken.text = token;
        this._oauthLoginHint.text =
            tokenPayload?.atproto?.identity?.handle || this._account.displayName;
        this._savedExcludedRepositories =
            accounts.getAccountExcludedRepositories(this._account.id);
        this._excludedRepositories.text = joinRepositoryFilters(
            this._savedExcludedRepositories,
        );

        /* Token help text */
        this._accessTokenHelp.label = FORGES[this._account.forge].tokenText;

        /* Save current account token */
        this._account.token = token;
        this._account.authMethod = authMethod;

        this._updateAuthMethodState();
        this._onEntryChanged();
    }

    _getExcludedRepositories() {
        return splitRepositoryFilters(this._excludedRepositories.text);
    }

    _filtersChanged() {
        const current = this._getExcludedRepositories();
        if (current.length !== this._savedExcludedRepositories.length) {
            return true;
        }

        return current.some(
            (filter, index) =>
                filter !== this._savedExcludedRepositories[index],
        );
    }

    _filtersValid() {
        const error = validateRepositoryFilters(this._getExcludedRepositories());
        if (error === null) {
            this._excludedRepositories.remove_css_class('error');
            return true;
        }

        this._excludedRepositories.add_css_class('error');
        return false;
    }

    _getSelectedForgeClass() {
        if (this.editing) {
            return FORGES[this._account.forge];
        }

        return this._forges_ls[this._forge.selected];
    }

    /**
     * Get selected forge name from the new account view
     *
     * @returns {string} The forge name
     */
    _getSelectedForge() {
        return this._getSelectedForgeClass().name;
    }

    /**
     * Get if selected forge in new account view allows instances
     *
     * @returns {boolean} If it allows instances
     */
    _allowInstances() {
        return this._getSelectedForgeClass().allowInstances;
    }

    /**
     * Get instance url set in the new account view.
     * Or forge default url if it doesn't allow instances
     *
     * @returns {string} If it allows instances
     */
    _getInstanceURL() {
        const forgeClass = this._getSelectedForgeClass();
        if (!this._allowInstances()) {
            return forgeClass.defaultURL;
        }

        const url = this._validateUrl(this._instance.text);
        const host = this._getUriHost(url);
        return host;
    }

    _getSelectedAuthMethod() {
        return this._authMethod.selected === 1 ? 'oauth' : 'token';
    }

    _forgeSupportsOAuth() {
        const forgeClass = this._getSelectedForgeClass();
        return (
            forgeClass.authMethods.includes('oauth') &&
            forgeClass.oauthConfig(this._getOAuthInstanceURL()) !== null
        );
    }

    _getOAuthInstanceURL() {
        const forgeClass = this._getSelectedForgeClass();
        if (!forgeClass.allowInstances) {
            return forgeClass.defaultURL;
        }

        try {
            return this._getUriHost(this._validateUrl(this._instance.text));
        } catch (_error) {
            return forgeClass.defaultURL;
        }
    }

    _getOAuthConfig() {
        const forgeClass = this._getSelectedForgeClass();
        if (!forgeClass.authMethods.includes('oauth')) {
            return null;
        }

        return forgeClass.oauthConfig(this._getInstanceURL());
    }

    _getOAuthLoginHint() {
        const value = this._oauthLoginHint.text.trim();
        if (/^https?:\/\//i.test(value)) {
            return value;
        }

        return value.startsWith('@') ? value.slice(1) : value;
    }

    _setOAuthStatus(message, tone = 'info') {
        const styles = ['accent', 'success', 'warning', 'error', 'dim-label'];
        for (const style of styles) {
            this._oauthStatus.remove_css_class(style);
        }

        if (tone === 'success') {
            this._oauthStatus.add_css_class('success');
        } else if (tone === 'warning') {
            this._oauthStatus.add_css_class('warning');
        } else if (tone === 'error') {
            this._oauthStatus.add_css_class('error');
        } else if (tone === 'info') {
            this._oauthStatus.add_css_class('accent');
        } else {
            this._oauthStatus.add_css_class('dim-label');
        }

        this._oauthStatus.label = message;
        this._oauthStatus.visible = message !== '';
    }

    _clearOAuthStatus() {
        this._oauthStatus.label = '';
        this._oauthStatus.visible = false;
    }

    _clearOAuthDeviceDetails() {
        this._oauthDeviceCode.text = '';
        this._oauthDeviceUri.text = '';
        this._oauthDeviceCode.visible = false;
        this._oauthDeviceUri.visible = false;
        this._oauthDeviceActions.visible = false;
    }

    _setOAuthDeviceDetails(device) {
        const uri =
            device.verification_uri_complete || device.verification_uri || '';
        this._oauthDeviceCode.text = device.user_code || '';
        this._oauthDeviceUri.text = uri;
        this._oauthDeviceCode.visible = this._oauthDeviceCode.text !== '';
        this._oauthDeviceUri.visible = this._oauthDeviceUri.text !== '';
        this._oauthDeviceActions.visible =
            this._oauthDeviceCode.visible || this._oauthDeviceUri.visible;

        if (this._oauthDeviceCode.visible) {
            this._oauthDeviceCode.select_region(0, -1);
        }

        return uri;
    }

    _setOAuthBusy(busy) {
        this._oauthBusy = busy;
        this._oauthLogin.sensitive = !busy;
        this._oauthExchange.sensitive = !busy;
        if (busy) {
            this._saveBtn.sensitive = false;
        }
    }

    _resetOAuthFlow() {
        this._oauthTokenPayload = null;
        this._oauthRequest = null;
        this._oauthCode.text = '';
        this._clearOAuthDeviceDetails();
        this._clearOAuthStatus();
    }

    _copyText(text, toastText) {
        if (!text) {
            return;
        }

        this.get_clipboard().set_content(
            Gdk.ContentProvider.new_for_value(text),
        );
        this._toasts.add_toast(
            new Adw.Toast({
                title: toastText,
            }),
        );
    }

    _onOAuthCopyDeviceCode() {
        this._copyText(this._oauthDeviceCode.text, _('Device code copied'));
    }

    _onOAuthOpenDeviceUri() {
        if (this._oauthDeviceUri.text) {
            openOAuthURI(this._oauthDeviceUri.text);
        }
    }

    _getAccessTokenForSave() {
        if (this._getSelectedAuthMethod() === 'oauth') {
            return this._oauthTokenPayload?.access_token || '';
        }

        return this._accessToken.text;
    }

    _getSecretForSave() {
        if (this._getSelectedAuthMethod() === 'oauth') {
            return this._oauthTokenPayload;
        }

        return this._accessToken.text;
    }

    _updateAuthMethodState() {
        const supportsOAuth = this._forgeSupportsOAuth();
        if (!supportsOAuth && this._authMethod.selected === 1) {
            this._authMethod.selected = 0;
        }

        const authMethod = this._getSelectedAuthMethod();
        const usingOAuth = supportsOAuth && authMethod === 'oauth';
        let config = null;
        if (usingOAuth) {
            try {
                config = this._getOAuthConfig();
            } catch (_error) {
                config = null;
            }
        }
        const usingAtproto = config?.flow === 'atproto';

        this._authMethod.visible = supportsOAuth;
        this._accessToken.visible = !usingOAuth;
        this._accessTokenHelp.visible = !usingOAuth;
        this._oauthStatusRow.visible = usingOAuth;
        this._oauthStatus.visible =
            usingOAuth && this._oauthStatus.label !== '';
        this._oauthLoginHint.visible = usingAtproto;
        this._oauthCode.visible = usingOAuth && this._oauthRequest !== null;
        this._oauthExchange.visible =
            usingOAuth &&
            this._oauthRequest !== null &&
            config?.flow !== 'device';
        this._oauthDeviceCode.visible =
            usingOAuth && this._oauthDeviceCode.text !== '';
        this._oauthDeviceUri.visible =
            usingOAuth && this._oauthDeviceUri.text !== '';
        this._oauthDeviceActions.visible =
            this._oauthDeviceCode.visible || this._oauthDeviceUri.visible;

        if (!usingOAuth) {
            this._clearOAuthStatus();
            this._clearOAuthDeviceDetails();
            return;
        }

        if (this._oauthTokenPayload !== null) {
            this._oauthStatusRow.subtitle = '';
            this._oauthLogin.label = _('Sign In Again');
            if (this._oauthStatus.label === '') {
                this._setOAuthStatus(
                    _('OAuth sign-in is ready. Save the account to finish.'),
                    'success',
                );
            }
        } else if (this._oauthRequest !== null) {
            this._oauthStatusRow.subtitle = '';
            this._oauthLogin.label = _('Open Browser Again');
            if (this._oauthStatus.label === '') {
                this._setOAuthStatus(
                    _('Paste the authorization code or redirect URL below.'),
                    'warning',
                );
            }
        } else if (usingAtproto) {
            this._oauthStatusRow.subtitle = '';
            this._oauthLogin.label = _('Sign In');
            if (this._oauthStatus.label === '') {
                this._setOAuthStatus(
                    _('Enter your AT Protocol handle or DID, then sign in.'),
                    'muted',
                );
            }
        } else {
            this._oauthStatusRow.subtitle = '';
            this._oauthLogin.label = _('Sign In');
            if (this._oauthStatus.label === '') {
                this._setOAuthStatus(
                    _('Sign in with your browser to request an access token.'),
                    'muted',
                );
            }
        }

        this._oauthLogin.sensitive = !this._oauthBusy;
        this._oauthExchange.sensitive = !this._oauthBusy;
    }

    /**
     * Get host from GLib.Uri with the www removed
     *
     * @param {GLib.Uri} uri URL to get the host
     * @returns {string} The URI host
     */
    _getUriHost(uri) {
        let host = uri.get_host();
        if (host.startsWith('www.')) {
            host = host.slice(4);
        }
        return host;
    }

    /**
     * Callback for when the selected forge changes in the add new account view
     */
    _onForgeChanged() {
        /* Enable or disable instance URL entry */
        this._instance.visible = this._allowInstances();

        /* Load default instance url */
        if (!this._userChangedInstance && this._account === null) {
            this._instance.text = this._getSelectedForgeClass().defaultURL;
        }

        /* Token help text */
        this._accessTokenHelp.label = this._getSelectedForgeClass().tokenText;

        this._resetOAuthFlow();
        this._oauthLoginHint.text = '';
        this._updateAuthMethodState();
        this._onEntryChanged();
    }

    /**
     * Validate and get GLib.Uri from url string
     *
     * @param {string} url URL to validate
     * @trows Trows an error if GLib failed parsing the url
     * @returns {GLib.Uri} Parser URI
     */
    _validateUrl(url) {
        /* Force https */
        if (!/^https?:\/\//i.test(url)) {
            url = 'https://' + url;
        }

        try {
            const parse = GLib.Uri.parse(url, GLib.UriFlags.RELAXED);
            return parse;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Callback when user changes the instance entry
     *
     * Updates the _userChangedInstance value so we don't override the user input
     * when them change the selected forge.
     */
    _onInstanceChanged() {
        this._userChangedInstance =
            !this.editing &&
            this._instance.text !== this._getSelectedForgeClass().defaultURL;
        this._updateAuthMethodState();
        this._onEntryChanged();
    }

    _onAuthMethodChanged() {
        this._updateAuthMethodState();
        this._onEntryChanged();
    }

    async _onOAuthLogin() {
        try {
            const config = this._getOAuthConfig();
            if (config === null) {
                throw 'OAuthUnsupported';
            }

            this._setOAuthBusy(true);

            if (config.flow === 'device') {
                this._oauthTokenPayload = null;
                this._clearOAuthDeviceDetails();
                this._setOAuthStatus(
                    _('Requesting a device code from the provider.'),
                    'info',
                );
                this._oauthTokenPayload = await startDeviceOAuth(
                    config,
                    {
                        onDeviceCode: (device) => {
                            const uri = this._setOAuthDeviceDetails(device);
                            const interval = Number(
                                device.interval || config.interval || 5,
                            );
                            this._setOAuthStatus(
                                _(
                                    'Enter the device code in your browser. Cinders will check for approval every ',
                                ) +
                                    interval +
                                    _(' seconds.'),
                                'warning',
                            );
                            if (uri) {
                                openOAuthURI(uri);
                            }
                        },
                        onPoll: (poll) => {
                            this._onOAuthDevicePoll(poll);
                        },
                    },
                );
                this._clearOAuthDeviceDetails();
                this._setOAuthStatus(
                    _('OAuth sign-in completed. Save the account to finish.'),
                    'success',
                );
            } else if (config.flow === 'pkce') {
                if (this._oauthRequest === null) {
                    this._oauthTokenPayload = null;
                    this._clearOAuthDeviceDetails();
                    this._oauthRequest = createPkceRequest(config);
                    this._oauthCode.text = '';
                    this._setOAuthStatus(
                        _(
                            'Browser sign-in opened. Paste the final redirect URL or authorization code below.',
                        ),
                        'warning',
                    );
                    this._updateAuthMethodState();
                    openOAuthURI(this._oauthRequest.authorizationUrl);
                    return;
                }

                this._setOAuthStatus(
                    _(
                        'Browser sign-in is already in progress. Paste the redirect URL below, or reopen the browser.',
                    ),
                    'warning',
                );
                openOAuthURI(this._oauthRequest.authorizationUrl);
                return;
            } else if (config.flow === 'atproto') {
                if (this._oauthRequest === null) {
                    this._oauthTokenPayload = null;
                    this._clearOAuthDeviceDetails();
                    this._setOAuthStatus(
                        _('Resolving your AT Protocol account.'),
                        'info',
                    );
                    this._oauthRequest = await startAtprotoOAuth(
                        config,
                        this._getOAuthLoginHint(),
                    );
                    this._oauthCode.text = '';
                    this._setOAuthStatus(
                        _(
                            'Browser sign-in opened. Paste the final redirect URL or authorization code below.',
                        ),
                        'warning',
                    );
                    this._updateAuthMethodState();
                    openOAuthURI(this._oauthRequest.authorizationUrl);
                    return;
                }

                this._setOAuthStatus(
                    _(
                        'Browser sign-in is already in progress. Paste the redirect URL below, or reopen the browser.',
                    ),
                    'warning',
                );
                openOAuthURI(this._oauthRequest.authorizationUrl);
                return;
            } else {
                throw 'OAuthUnsupported';
            }

            this._accessToken.text = this._oauthTokenPayload.access_token;
        } catch (error) {
            console.error(error);
            this._setOAuthStatus(this._errorText(error), 'error');
            this._toasts.add_toast(
                new Adw.Toast({
                    title: this._errorText(error),
                }),
            );
        } finally {
            this._setOAuthBusy(false);
            this._updateAuthMethodState();
            this._onEntryChanged();
        }
    }

    _onOAuthDevicePoll(poll) {
        switch (poll.state) {
            case 'waiting':
                this._setOAuthStatus(
                    _('Waiting for browser approval. Next check in ') +
                        poll.interval +
                        _(' seconds.'),
                    'warning',
                );
                break;
            case 'checking':
                this._setOAuthStatus(
                    _('Checking provider for approval, attempt ') +
                        poll.attempt +
                        '.',
                    'info',
                );
                break;
            case 'pending':
                this._setOAuthStatus(
                    _('Still waiting for approval. Keep the browser page open.'),
                    'warning',
                );
                break;
            case 'slow_down':
                this._setOAuthStatus(
                    _('Provider asked Cinders to slow down. Next check in ') +
                        poll.interval +
                        _(' seconds.'),
                    'warning',
                );
                break;
            case 'authorized':
                this._setOAuthStatus(
                    _('Provider approved the sign-in. Finishing setup.'),
                    'success',
                );
                break;
        }
    }

    async _onOAuthExchange() {
        try {
            const config = this._getOAuthConfig();
            if (config === null || this._oauthRequest === null) {
                throw 'OAuthUnsupported';
            }

            this._setOAuthBusy(true);
            this._setOAuthStatus(_('Exchanging authorization code.'), 'info');

            if (config.flow === 'pkce') {
                this._oauthTokenPayload = await exchangeAuthorizationCode(
                    config,
                    this._oauthRequest,
                    this._oauthCode.text,
                );
            } else if (config.flow === 'atproto') {
                this._oauthTokenPayload =
                    await exchangeAtprotoAuthorizationCode(
                        config,
                        this._oauthRequest,
                        this._oauthCode.text,
                    );
            } else {
                throw 'OAuthUnsupported';
            }

            this._oauthRequest = null;
            this._oauthCode.text = '';
            this._accessToken.text = this._oauthTokenPayload.access_token;
            this._setOAuthStatus(
                _('OAuth sign-in completed. Save the account to finish.'),
                'success',
            );
        } catch (error) {
            console.error(error);
            this._setOAuthStatus(this._errorText(error), 'error');
            this._toasts.add_toast(
                new Adw.Toast({
                    title: this._errorText(error),
                }),
            );
        } finally {
            this._setOAuthBusy(false);
            this._updateAuthMethodState();
            this._onEntryChanged();
        }
    }

    /**
     * Callback when any entry changes
     * Validate instance url and access token.
     *
     * Updates save button sensitivity after validating the values.
     */
    _onEntryChanged() {
        if (this._oauthBusy) {
            this._saveBtn.sensitive = false;
            return;
        }

        let valid = false;
        const filtersValid = this._filtersValid();
        const authMethod = this._getSelectedAuthMethod();
        const authReady =
            authMethod === 'token'
                ? this._accessToken.text !== ''
                : this._oauthTokenPayload !== null;

        if (this.editing && this._account !== null) {
            const instances = this._getSelectedForgeClass().allowInstances;
            const urlChanged = this._account.url !== this._instance.text;
            const authMethodChanged = authMethod !== this._savedAuthMethod;
            const tokenChanged =
                this._account.token !== this._getAccessTokenForSave();
            const filtersChanged = this._filtersChanged();
            const urlNotEmpty = this._instance.text !== '';
            const authChanged = authMethodChanged || tokenChanged;

            if (instances) {
                try {
                    this._validateUrl(this._instance.text);
                    this._instance.remove_css_class('error');
                    valid =
                        filtersValid &&
                        urlNotEmpty &&
                        authReady &&
                        (urlChanged || authChanged || filtersChanged);
                } catch (error) {
                    this._instance.add_css_class('error');
                    this._toasts.add_toast(
                        new Adw.Toast({
                            title: _('Invalid instance url.'),
                        }),
                    );
                }
            } else {
                valid =
                    filtersValid &&
                    authReady &&
                    (authChanged || filtersChanged);
            }
        } else {
            if (this._allowInstances()) {
                try {
                    this._validateUrl(this._instance.text);
                    this._instance.remove_css_class('error');
                    valid =
                        filtersValid &&
                        authReady &&
                        this._instance.text !== '';
                } catch (error) {
                    this._instance.add_css_class('error');
                    this._toasts.add_toast(
                        new Adw.Toast({
                            title: _('Invalid instance url.'),
                        }),
                    );
                }
            } else {
                valid = filtersValid && authReady;
            }
        }

        this._saveBtn.sensitive = valid;
    }

    /**
     * Get error user visible text
     *
     * @returns {string} The error text
     */
    _errorText(error) {
        const isObject = typeof error === 'object' && error !== null;
        const code = isObject
            ? error.code || error.name || error.message
            : error;
        const detail = isObject ? error.detail || error.message || '' : '';

        switch (code) {
            case 'FailedForgeAuth':
                return _('Couldn’t authenticate the account');
            case 'FailedTokenScopes':
                return _('The access token doesn’t have the needed scopes');
            case 'OAuthExpired':
                return _('The OAuth authorization expired');
            case 'OAuthMissingCode':
                return _('Paste the authorization code or redirect URL');
            case 'OAuthMissingLoginHint':
                return _('Enter an AT Protocol handle or DID');
            case 'OAuthHandleResolutionFailed':
                return _('Couldn’t resolve that AT Protocol handle or DID');
            case 'OAuthIssuerMismatch':
                return _('The OAuth issuer did not match the account');
            case 'OAuthStateMismatch':
                return _('The OAuth response did not match this request');
            case 'OAuthUnsupported':
                return _('This forge does not support OAuth login yet');
            case 'InvalidRequest':
            case 'invalid_request':
                return detail || _('The OAuth provider rejected the request');
            case 'OAuthUnexpected':
                return detail || _('Unexpected error when creating the account');
            default:
                return detail || _('Unexpected error when creating the account');
        }
    }

    /**
     * Callback when the user clicks the cancel button.
     */
    _onCancel() {
        this.close();
    }

    /**
     * Callback when the user clicks the save button.
     */
    _onSave() {
        if (this.editing) {
            this._updateAccount();
        } else {
            this._addAccount();
        }
    }

    /**
     * Callback when the user adds an account.
     * Save account in settings.
     */
    async _addAccount() {
        try {
            /* Make the whole form insensitive */
            this._page.sensitive = false;

            /* Get form values */
            const authMethod = this._getSelectedAuthMethod();
            const token = this._getAccessTokenForSave();
            const secret = this._getSecretForSave();
            const url = this._getInstanceURL();
            const forgeName = this._getSelectedForge();
            const excludedRepositories = this._getExcludedRepositories();

            if (authMethod === 'oauth' && secret === null) {
                throw 'OAuthMissingCode';
            }

            /**
             * Instantiate the class for the forge
             * @type {import('../forges/forge.js').default}
             */
            const forge = new FORGES[forgeName](
                url,
                token,
                null,
                null,
                '',
                [],
                authMethod,
                secret,
            );
            /* Try authenticating the user with access token */
            const [userId, username] = await forge.getUser();

            if (username !== undefined) {
                /* Save account to settings */
                await accounts.saveAccount(
                    forgeName,
                    url,
                    userId,
                    username,
                    secret,
                    {
                        authMethod: authMethod,
                        excludedRepositories: excludedRepositories,
                    },
                );
            }

            this.close();

            /* Reload notifications */
            Adw.Application.get_default()
                .lookup_action('reload')
                .activate(null);
        } catch (error) {
            console.error(error);
            this._toasts.add_toast(
                new Adw.Toast({
                    title: this._errorText(error),
                }),
            );
        } finally {
            this._page.sensitive = true;
        }
    }

    /**
     * Callback when the user saves an account new preferences.
     * Update account in settings.
     */
    async _updateAccount() {
        if (!this.editing) return;

        /* Make the whole form insensitive */
        this._page.sensitive = false;

        /* Get and validate from values */
        const forgeClass = FORGES[this._account.forge];
        const authMethod = this._getSelectedAuthMethod();
        const newToken = this._getAccessTokenForSave();
        const newSecret = this._getSecretForSave();
        let newUrl = this._instance.text;
        const excludedRepositories = this._getExcludedRepositories();
        const filtersChanged = this._filtersChanged();

        if (authMethod === 'oauth' && newSecret === null) {
            this._toasts.add_toast(
                new Adw.Toast({
                    title: this._errorText('OAuthMissingCode'),
                }),
            );
            this._page.sensitive = true;
            return;
        }

        if (!forgeClass.allowInstances) {
            newUrl = forgeClass.defaultURL;
        } else {
            newUrl = this._validateUrl(newUrl);
            newUrl = this._getUriHost(newUrl);
        }

        /* Continue if some value has actually changed */
        if (
            newToken !== this._account.token ||
            newUrl !== this._account.url ||
            authMethod !== this._savedAuthMethod
        ) {
            try {
                const forge = new forgeClass(
                    newUrl,
                    newToken,
                    null,
                    null,
                    '',
                    [],
                    authMethod,
                    newSecret,
                );
                const [userId, username] = await forge.getUser();

                await accounts.updateAccount(
                    this._account.id,
                    newUrl,
                    userId,
                    username,
                    newSecret,
                    {
                        authMethod: authMethod,
                        excludedRepositories: excludedRepositories,
                    },
                );

                Adw.Application.get_default().window.resetAccountForge(
                    this._account.id,
                );
                this.close();

                /* Reload notifications */
                Adw.Application.get_default()
                    .lookup_action('reload')
                    .activate(null);
            } catch (error) {
                console.error(error);
                this._toasts.add_toast(
                    new Adw.Toast({
                        title: this._errorText(error),
                    }),
                );
            }
        } else if (filtersChanged) {
            accounts.updateAccountSettings(this._account.id, {
                excludedRepositories: excludedRepositories,
            });

            Adw.Application.get_default().window.resetAccountForge(
                this._account.id,
            );
            this.close();

            /* Reload notifications */
            Adw.Application.get_default()
                .lookup_action('reload')
                .activate(null);
        }

        this._page.sensitive = true;
    }

    /**
     * Callback when the user removes an account
     */
    async _onRemoveAccount() {
        if (!this.editing) return;

        const errorToast = new Adw.Toast({
            title: _('Unexpected error removing the account'),
        });
        try {
            const success = await accounts.removeAccount(this._account.id);
            if (!success) {
                this._toasts.add_toast(errorToast);
            } else {
                this.close();

                /* Reload notifications */
                Adw.Application.get_default()
                    .lookup_action('reload')
                    .activate(null);
            }
        } catch (error) {
            this._toasts.add_toast(errorToast);
        }
    }
}
