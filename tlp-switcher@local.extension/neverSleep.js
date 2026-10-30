import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// org.gnome.SessionManager InhibitFlags: SUSPEND (4) | IDLE (8)
const SESSION_INHIBIT_FLAGS = 4 | 8;

// org.gnome.Mutter.DisplayConfig PowerSaveMode values (DPMS)
const POWER_SAVE_MODE_ON = 0;
const POWER_SAVE_MODE_OFF = 3;

export class NeverSleepController {
    constructor(appId = 'tlp-switcher@local.extension') {
        this._appId = appId;
        this._enabled = false;
        this._transitionToken = 0;
        this._cancellable = null;

        this._logindInhibitFd = -1;
        this._sessionInhibitCookie = 0;

        this._upowerSignalId = 0;
        this._displaySignalId = 0;
        this._reblankTimeoutId = 0;

        this._lidIsClosed = false;
        this._hasExternalMonitor = false;
        this._forcedMonitorOff = false;

        this._injectionManager = new InjectionManager();
    }

    get enabled() {
        return this._enabled;
    }

    get lidIsClosed() {
        return this._lidIsClosed;
    }

    async setEnabled(enabled) {
        const target = Boolean(enabled);
        if (this._enabled === target) {
            return true;
        }

        const token = ++this._transitionToken;
        if (target) {
            return await this._enableInternal(token);
        } else {
            this._disableInternal();
            return true;
        }
    }

    async _enableInternal(token) {
        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;

        this._enabled = true;
        this._installScreenSaverLidGuard();
        this._subscribeSignals();

        try {
            const [fd, cookie, lidClosed, hasExternal] = await Promise.all([
                this._acquireLogindInhibitor(cancellable),
                this._acquireSessionInhibitor(cancellable),
                this._getDBusBoolProperty(
                    Gio.DBus.system,
                    'org.freedesktop.UPower',
                    '/org/freedesktop/UPower',
                    'org.freedesktop.UPower',
                    'LidIsClosed',
                    cancellable
                ),
                this._getDBusBoolProperty(
                    Gio.DBus.session,
                    'org.gnome.Mutter.DisplayConfig',
                    '/org/gnome/Mutter/DisplayConfig',
                    'org.gnome.Mutter.DisplayConfig',
                    'HasExternalMonitor',
                    cancellable
                ),
            ]);

            if (token !== this._transitionToken || !this._enabled) {
                if (fd >= 0) {
                    try {
                        GLib.close(fd);
                    } catch (_err) {
                        // Ignore close error on stale fd
                    }
                }
                if (cookie > 0) {
                    this._uninhibitSessionCookie(cookie);
                }
                return false;
            }

            this._logindInhibitFd = fd;
            this._sessionInhibitCookie = cookie;
            this._lidIsClosed = lidClosed;
            this._hasExternalMonitor = hasExternal;

            this._syncDisplayPower(false);
            return true;
        } catch (err) {
            if (!err.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                console.error(`[TLP Switcher] Failed to enable Never Sleep Mode: ${err.message}`);
            }
            if (token === this._transitionToken) {
                this._disableInternal();
            }
            return false;
        }
    }

    _disableInternal() {
        this._enabled = false;

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._reblankTimeoutId) {
            GLib.Source.remove(this._reblankTimeoutId);
            this._reblankTimeoutId = 0;
        }

        this._unsubscribeSignals();
        this._injectionManager.clear();
        this._releaseSessionInhibitor();
        this._releaseLogindInhibitor();

        if (this._forcedMonitorOff) {
            this._forcedMonitorOff = false;
            this._setMonitorPowerSaveMode(POWER_SAVE_MODE_ON);
        }
    }

    _installScreenSaverLidGuard() {
        this._injectionManager.clear();

        const screenSaverDBus = Main.screenShield?._screenSaverDBus;
        if (!screenSaverDBus) {
            return;
        }

        // When SUSPEND is inhibited (by Never Sleep or a media player like Chrome/VLC)
        // and the laptop lid closes, gsd-power calls org.gnome.ScreenSaver.Lock or SetActive(true).
        // Suppressing that automatic lid-close lock keeps desktop apps/music/video active while
        // we switch off the physical monitor via DisplayConfig PowerSaveMode (DPMS OFF).
        this._injectionManager.overrideMethod(
            screenSaverDBus,
            'LockAsync',
            originalMethod => (parameters, invocation) => {
                if (this._enabled && this._queryLidIsClosedSync()) {
                    this._lidIsClosed = true;
                    invocation.return_value(null);
                    this._syncDisplayPower(false);
                    return;
                }
                originalMethod.call(screenSaverDBus, parameters, invocation);
            }
        );

        this._injectionManager.overrideMethod(
            screenSaverDBus,
            'SetActive',
            originalMethod => active => {
                if (active && this._enabled && this._queryLidIsClosedSync()) {
                    this._lidIsClosed = true;
                    this._syncDisplayPower(false);
                    return;
                }
                originalMethod.call(screenSaverDBus, active);
            }
        );
    }

    _subscribeSignals() {
        this._unsubscribeSignals();

        this._upowerSignalId = Gio.DBus.system.signal_subscribe(
            'org.freedesktop.UPower',
            'org.freedesktop.DBus.Properties',
            'PropertiesChanged',
            '/org/freedesktop/UPower',
            'org.freedesktop.UPower',
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                if (!this._enabled) {
                    return;
                }
                const [, changed] = params.recursiveUnpack();
                if (Object.prototype.hasOwnProperty.call(changed, 'LidIsClosed')) {
                    const wasClosed = this._lidIsClosed;
                    this._lidIsClosed = Boolean(changed.LidIsClosed);
                    const lidJustOpened = wasClosed && !this._lidIsClosed;
                    this._syncDisplayPower(lidJustOpened);
                }
            }
        );

        this._displaySignalId = Gio.DBus.session.signal_subscribe(
            'org.gnome.Mutter.DisplayConfig',
            'org.freedesktop.DBus.Properties',
            'PropertiesChanged',
            '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig',
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                if (!this._enabled) {
                    return;
                }
                const [, changed] = params.recursiveUnpack();

                if (Object.prototype.hasOwnProperty.call(changed, 'HasExternalMonitor')) {
                    this._hasExternalMonitor = Boolean(changed.HasExternalMonitor);
                    this._syncDisplayPower(false);
                }

                if (Object.prototype.hasOwnProperty.call(changed, 'PowerSaveMode')) {
                    const mode = Number(changed.PowerSaveMode);
                    // Keep the laptop display off if an accidental mouse/key input wakes DPMS while the lid is closed
                    if (
                        mode === POWER_SAVE_MODE_ON &&
                        this._lidIsClosed &&
                        !this._hasExternalMonitor
                    ) {
                        this._scheduleReblank();
                    }
                }
            }
        );
    }

    _unsubscribeSignals() {
        if (this._upowerSignalId) {
            Gio.DBus.system.signal_unsubscribe(this._upowerSignalId);
            this._upowerSignalId = 0;
        }

        if (this._displaySignalId) {
            Gio.DBus.session.signal_unsubscribe(this._displaySignalId);
            this._displaySignalId = 0;
        }
    }

    _scheduleReblank() {
        if (this._reblankTimeoutId) {
            return;
        }

        this._reblankTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._reblankTimeoutId = 0;
            if (this._enabled && this._lidIsClosed && !this._hasExternalMonitor) {
                this._forcedMonitorOff = true;
                this._setMonitorPowerSaveMode(POWER_SAVE_MODE_OFF);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncDisplayPower(lidJustOpened) {
        if (!this._enabled) {
            return;
        }

        if (this._lidIsClosed && !this._hasExternalMonitor) {
            this._forcedMonitorOff = true;
            this._setMonitorPowerSaveMode(POWER_SAVE_MODE_OFF);
        } else if (lidJustOpened || this._forcedMonitorOff) {
            this._forcedMonitorOff = false;
            this._setMonitorPowerSaveMode(POWER_SAVE_MODE_ON);
        }
    }

    _setMonitorPowerSaveMode(mode) {
        Gio.DBus.session.call(
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig',
            'org.freedesktop.DBus.Properties',
            'Set',
            new GLib.Variant('(ssv)', [
                'org.gnome.Mutter.DisplayConfig',
                'PowerSaveMode',
                new GLib.Variant('i', mode),
            ]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (err) {
                    console.warn(`[TLP Switcher] Could not set DisplayConfig PowerSaveMode=${mode}: ${err.message}`);
                }
            }
        );
    }

    _queryLidIsClosedSync() {
        if (this._lidIsClosed) {
            return true;
        }

        try {
            const reply = Gio.DBus.system.call_sync(
                'org.freedesktop.UPower',
                '/org/freedesktop/UPower',
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', ['org.freedesktop.UPower', 'LidIsClosed']),
                new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE,
                1000,
                null
            );
            const [val] = reply.recursiveUnpack();
            return Boolean(val);
        } catch (_err) {
            return this._lidIsClosed;
        }
    }

    _getDBusBoolProperty(bus, busName, objectPath, ifaceName, propName, cancellable) {
        return new Promise(resolve => {
            bus.call(
                busName,
                objectPath,
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', [ifaceName, propName]),
                new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE,
                -1,
                cancellable,
                (conn, res) => {
                    try {
                        const reply = conn.call_finish(res);
                        const [val] = reply.recursiveUnpack();
                        resolve(Boolean(val));
                    } catch (_err) {
                        resolve(false);
                    }
                }
            );
        });
    }

    _acquireLogindInhibitor(cancellable) {
        return new Promise((resolve, reject) => {
            const args = new GLib.Variant('(ssss)', [
                'handle-lid-switch:sleep:idle',
                'TLP Power Mode Switcher',
                'Never Sleep Mode: keep processes, music, and video running; switch off monitor on lid close',
                'block',
            ]);

            Gio.DBus.system.call_with_unix_fd_list(
                'org.freedesktop.login1',
                '/org/freedesktop/login1',
                'org.freedesktop.login1.Manager',
                'Inhibit',
                args,
                new GLib.VariantType('(h)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                cancellable,
                (conn, res) => {
                    try {
                        const [, fdList] = conn.call_with_unix_fd_list_finish(res);
                        const fds = fdList ? fdList.steal_fds() : [];
                        resolve(fds.length > 0 ? fds[0] : -1);
                    } catch (err) {
                        reject(err);
                    }
                }
            );
        });
    }

    _releaseLogindInhibitor() {
        if (this._logindInhibitFd >= 0) {
            try {
                GLib.close(this._logindInhibitFd);
            } catch (err) {
                console.warn(`[TLP Switcher] Error closing logind inhibitor fd: ${err.message}`);
            }
            this._logindInhibitFd = -1;
        }
    }

    _acquireSessionInhibitor(cancellable) {
        return new Promise((resolve, reject) => {
            const args = new GLib.Variant('(susu)', [
                this._appId,
                0,
                'Never Sleep Mode: keep laptop awake and media playing',
                SESSION_INHIBIT_FLAGS,
            ]);

            Gio.DBus.session.call(
                'org.gnome.SessionManager',
                '/org/gnome/SessionManager',
                'org.gnome.SessionManager',
                'Inhibit',
                args,
                new GLib.VariantType('(u)'),
                Gio.DBusCallFlags.NONE,
                -1,
                cancellable,
                (conn, res) => {
                    try {
                        const reply = conn.call_finish(res);
                        const [cookie] = reply.deepUnpack();
                        resolve(cookie);
                    } catch (err) {
                        reject(err);
                    }
                }
            );
        });
    }

    _uninhibitSessionCookie(cookie) {
        if (!cookie) {
            return;
        }

        Gio.DBus.session.call(
            'org.gnome.SessionManager',
            '/org/gnome/SessionManager',
            'org.gnome.SessionManager',
            'Uninhibit',
            new GLib.Variant('(u)', [cookie]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (_err) {
                    // Session may already be shutting down
                }
            }
        );
    }

    _releaseSessionInhibitor() {
        if (this._sessionInhibitCookie > 0) {
            const cookie = this._sessionInhibitCookie;
            this._sessionInhibitCookie = 0;
            this._uninhibitSessionCookie(cookie);
        }
    }

    destroy() {
        this._transitionToken++;
        this._disableInternal();
    }
}

