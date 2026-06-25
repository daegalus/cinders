// SPDX-License-Identifier: MIT

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { gettext as _, ngettext } from 'gettext';

const Format = imports.format;

function loadIndicatorNamespace() {
    try {
        imports.gi.versions.AyatanaAppIndicatorGlib = '2.0';
        return imports.gi.AyatanaAppIndicatorGlib;
    } catch (_error) {
        return null;
    }
}

export default class StatusIndicator {
    constructor(application) {
        this._application = application;
        this._Ayatana = loadIndicatorNamespace();
        this._indicator = null;
        this._actions = null;
        this._menu = null;
        this._count = 0;
    }

    init() {
        if (this._Ayatana === null) {
            return false;
        }

        try {
            this._actions = new Gio.SimpleActionGroup();
            this._menu = new Gio.Menu();
            this._buildActions();
            this._buildMenu();

            this._indicator = this._Ayatana.Indicator.new(
                pkg.name,
                pkg.name,
                this._Ayatana.IndicatorCategory.APPLICATION_STATUS,
            );
            this._indicator.set_title(GLib.get_application_name());
            this._indicator.set_status(
                this._Ayatana.IndicatorStatus.ACTIVE,
            );
            this._indicator.set_secondary_activate_target('show');
            this._indicator.set_menu(this._menu);
            this._indicator.set_actions(this._actions);
            this.updateCount(this._count);
            return true;
        } catch (error) {
            console.error(error);
            this.destroy();
            return false;
        }
    }

    destroy() {
        if (this._indicator !== null && this._Ayatana !== null) {
            this._indicator.set_status(
                this._Ayatana.IndicatorStatus.PASSIVE,
            );
        }

        this._indicator = null;
        this._actions = null;
        this._menu = null;
    }

    updateCount(count) {
        this._count = Math.max(0, Number(count) || 0);
        if (this._indicator === null) {
            return;
        }

        const label = this._count > 0 ? String(this._count) : '';
        this._indicator.set_label(label, '999');
        this._indicator.set_tooltip(
            pkg.name,
            GLib.get_application_name(),
            this._tooltipText(),
        );
    }

    _buildActions() {
        this._addAction('show', () => {
            this._application.activate();
        });

        this._addAction('reload', () => {
            this._application.reload();
        });

        this._addAction('accounts', () => {
            this._application.activate();
            this._application.lookup_action('accounts').activate(null);
        });

        this._addAction('preferences', () => {
            this._application.activate();
            this._application.lookup_action('preferences').activate(null);
        });

        this._addAction('quit', () => {
            this._application.quit();
        });
    }

    _buildMenu() {
        this._menu.append(_('Show Cinders'), 'indicator.show');
        this._menu.append(_('Refresh'), 'indicator.reload');
        this._menu.append(_('Accounts'), 'indicator.accounts');
        this._menu.append(_('Preferences'), 'indicator.preferences');
        this._menu.append(_('Quit'), 'indicator.quit');
    }

    _addAction(name, callback) {
        const action = new Gio.SimpleAction({ name });
        action.connect('activate', callback);
        this._actions.add_action(action);
    }

    _tooltipText() {
        if (this._count === 0) {
            return _('No unread notifications');
        }

        return Format.vprintf(
            ngettext(
                '%d unread notification',
                '%d unread notifications',
                this._count,
            ),
            [this._count],
        );
    }
}
