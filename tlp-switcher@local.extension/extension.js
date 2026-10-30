import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { NeverSleepController } from './neverSleep.js';

const TLP_BIN = '/usr/sbin/tlp';
const TLP_STAT_BIN = '/usr/bin/tlp-stat';
const TLP_RUN_DIR = '/run/tlp';
const POLL_INTERVAL_SECONDS = 15;

const TlpIndicator = GObject.registerClass(
class TlpIndicator extends PanelMenu.Button {
    _init(settings, openPreferencesCallback) {
        super._init(0.0, 'TLP Power Mode Switcher', false);

        this._settings = settings;
        this._openPreferencesCallback = openPreferencesCallback;
        this._cancellable = new Gio.Cancellable();
        this._isSwitching = false;
        this._pollTimeoutId = null;
        this._debounceTimeoutId = null;
        this._fileMonitor = null;
        this._fileMonitorChangedId = null;

        this._state = {
            serviceState: 'unknown',
            mode: 'unknown',      // 'AC' | 'battery' | 'unknown'
            isManual: false,      // true when '(manual)' or '(persistent)'
            rawMode: 'unknown',   // full string from tlp-stat -s
            powerSource: 'unknown',
            lastRun: 'unknown',
        };

        this._buildPanelWidget();
        this._buildMenu();
        this._setupFileMonitor();
        this._startPolling();

        // Refresh immediately on startup
        this._refreshStatus();
    }

    _buildPanelWidget() {
        this._panelBox = new St.BoxLayout({
            style_class: 'panel-status-menu-box tlp-panel-box',
        });

        this._panelIcon = new St.Icon({
            icon_name: 'power-profile-balanced-symbolic',
            style_class: 'system-status-icon',
        });

        this._panelLabel = new St.Label({
            text: 'TLP',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'tlp-panel-label',
        });

        this._awakeIcon = new St.Icon({
            icon_name: 'view-reveal-symbolic',
            style_class: 'system-status-icon tlp-awake-icon',
            visible: false,
        });

        this._panelBox.add_child(this._panelIcon);
        this._panelBox.add_child(this._panelLabel);
        this._panelBox.add_child(this._awakeIcon);
        this.add_child(this._panelBox);
    }

    _buildMenu() {
        // Status overview section
        const statusSection = new PopupMenu.PopupMenuSection();
        this._statusItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        const statusBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
        });

        this._headerLabel = new St.Label({
            text: 'TLP Power Switcher',
            style_class: 'tlp-status-header',
        });

        this._modeStatusLabel = new St.Label({
            text: 'Active Mode: Checking...',
            style_class: 'tlp-status-subtext',
        });

        this._powerSourceLabel = new St.Label({
            text: 'Power Source: Checking...',
            style_class: 'tlp-status-subtext',
        });

        this._serviceStateLabel = new St.Label({
            text: 'TLP Service: Checking...',
            style_class: 'tlp-status-subtext',
        });

        this._neverSleepStatusLabel = new St.Label({
            text: 'Never Sleep: Off',
            style_class: 'tlp-status-subtext',
        });

        this._overrideBannerLabel = new St.Label({
            text: '',
            style_class: 'tlp-override-banner',
            visible: false,
        });

        this._awakeBannerLabel = new St.Label({
            text: '👁 Never Sleep Active — Monitor turns off on lid close',
            style_class: 'tlp-awake-banner',
            visible: false,
        });

        statusBox.add_child(this._headerLabel);
        statusBox.add_child(this._modeStatusLabel);
        statusBox.add_child(this._powerSourceLabel);
        statusBox.add_child(this._serviceStateLabel);
        statusBox.add_child(this._neverSleepStatusLabel);
        statusBox.add_child(this._overrideBannerLabel);
        statusBox.add_child(this._awakeBannerLabel);

        this._statusItem.add_child(statusBox);
        statusSection.addMenuItem(this._statusItem);
        this.menu.addMenuItem(statusSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Mode action items
        this._acItem = new PopupMenu.PopupImageMenuItem(
            'Force High Performance (AC Mode)',
            'power-profile-performance-symbolic'
        );
        this._acItem.connect('activate', () => {
            this._switchTlpMode('ac', 'High Performance (AC)');
        });
        this.menu.addMenuItem(this._acItem);

        this._batItem = new PopupMenu.PopupImageMenuItem(
            'Force Battery Savings (BAT Mode)',
            'power-profile-power-saver-symbolic'
        );
        this._batItem.connect('activate', () => {
            this._switchTlpMode('bat', 'Battery Savings (BAT)');
        });
        this.menu.addMenuItem(this._batItem);

        this._autoItem = new PopupMenu.PopupImageMenuItem(
            'Automatic Mode (Follow Power Cord)',
            'power-profile-balanced-symbolic'
        );
        this._autoItem.connect('activate', () => {
            this._switchTlpMode('start', 'Automatic (Default)');
        });
        this.menu.addMenuItem(this._autoItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Never Sleep toggle switch (placed right before Refresh TLP Status)
        const initialNeverSleep = this._settings?.get_boolean('never-sleep') ?? false;
        this._neverSleepSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Never Sleep Mode',
            initialNeverSleep
        );
        const neverSleepIcon = new St.Icon({
            icon_name: 'view-reveal-symbolic',
            style_class: 'popup-menu-icon',
        });
        this._neverSleepSwitch.insert_child_below(neverSleepIcon, this._neverSleepSwitch.label);
        this._neverSleepSwitch.connect('toggled', (_item, state) => {
            if (this._settings && this._settings.get_boolean('never-sleep') !== state) {
                this._settings.set_boolean('never-sleep', state);
                Main.notify(
                    state ? 'Never Sleep Mode Enabled' : 'Never Sleep Mode Disabled',
                    state
                        ? 'All processes, music, and video stay active; monitor turns off when lid is closed.'
                        : 'Standard system sleep and lid-close behavior restored.'
                );
            }
        });
        this.menu.addMenuItem(this._neverSleepSwitch);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Refresh button
        this._refreshItem = new PopupMenu.PopupImageMenuItem(
            'Refresh TLP Status',
            'view-refresh-symbolic'
        );
        this._refreshItem.connect('activate', () => {
            this._refreshStatus();
        });
        this.menu.addMenuItem(this._refreshItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Panel Position Submenu
        this._positionSubMenu = new PopupMenu.PopupSubMenuMenuItem('Panel Position');
        this._positionItems = {};

        const positions = [
            { key: 'left', label: 'Left' },
            { key: 'center', label: 'Center' },
            { key: 'right', label: 'Right' },
        ];

        for (const { key, label } of positions) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => {
                if (this._settings) {
                    this._settings.set_string('panel-position', key);
                }
            });
            this._positionSubMenu.menu.addMenuItem(item);
            this._positionItems[key] = item;
        }
        this.menu.addMenuItem(this._positionSubMenu);

        // Extension Settings button
        this._settingsItem = new PopupMenu.PopupImageMenuItem(
            'Extension Settings',
            'preferences-system-symbolic'
        );
        this._settingsItem.connect('activate', () => {
            this._openPreferencesCallback?.();
        });
        this.menu.addMenuItem(this._settingsItem);

        this.updatePositionOrnament();
        this.updateNeverSleepUI();

        // Refresh status whenever the user opens the menu
        this._menuOpenChangedId = this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                this._refreshStatus();
            }
        });
    }

    updateNeverSleepUI() {
        const isNeverSleep = this._settings?.get_boolean('never-sleep') ?? false;

        if (this._awakeIcon) {
            this._awakeIcon.visible = isNeverSleep;
        }

        if (this._neverSleepSwitch && this._neverSleepSwitch.state !== isNeverSleep) {
            this._neverSleepSwitch.setToggleState(isNeverSleep);
        }

        if (this._neverSleepStatusLabel) {
            this._neverSleepStatusLabel.set_text(
                isNeverSleep
                    ? 'Never Sleep: Active (Monitor off on lid close)'
                    : 'Never Sleep: Off'
            );
        }

        if (this._awakeBannerLabel) {
            this._awakeBannerLabel.visible = isNeverSleep;
        }
    }

    updatePositionOrnament() {
        if (!this._settings || !this._positionItems) {
            return;
        }

        const currentPos = this._settings.get_string('panel-position') || 'right';
        const labels = {
            left: 'Left',
            center: 'Center',
            right: 'Right',
        };

        this._positionSubMenu?.label.set_text(`Panel Position: ${labels[currentPos] || 'Right'}`);

        for (const [key, item] of Object.entries(this._positionItems)) {
            item.setOrnament(
                key === currentPos
                    ? PopupMenu.Ornament.CHECK
                    : PopupMenu.Ornament.NONE
            );
        }
    }

    _setupFileMonitor() {
        try {
            const runDirFile = Gio.File.new_for_path(TLP_RUN_DIR);
            this._fileMonitor = runDirFile.monitor_directory(
                Gio.FileMonitorFlags.NONE,
                this._cancellable
            );
            this._fileMonitorChangedId = this._fileMonitor.connect('changed', () => {
                if (this._debounceTimeoutId) {
                    GLib.Source.remove(this._debounceTimeoutId);
                }
                this._debounceTimeoutId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    400,
                    () => {
                        this._debounceTimeoutId = null;
                        this._refreshStatus();
                        return GLib.SOURCE_REMOVE;
                    }
                );
            });
        } catch (err) {
            console.warn(`[TLP Switcher] Could not monitor ${TLP_RUN_DIR}: ${err.message}`);
        }
    }

    _startPolling() {
        this._pollTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            POLL_INTERVAL_SECONDS,
            () => {
                this._refreshStatus();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _execCommandAsync(argv) {
        return new Promise((resolve, reject) => {
            try {
                const launcher = new Gio.SubprocessLauncher({
                    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                });
                launcher.setenv('LC_ALL', 'C', true);
                launcher.setenv('LANG', 'C', true);

                const proc = launcher.spawnv(argv);
                proc.communicate_utf8_async(null, this._cancellable, (subprocess, res) => {
                    try {
                        const [, stdout, stderr] = subprocess.communicate_utf8_finish(res);
                        const exitStatus = subprocess.get_exit_status();
                        resolve({
                            ok: subprocess.get_successful(),
                            exitStatus,
                            stdout: stdout ? stdout.trim() : '',
                            stderr: stderr ? stderr.trim() : '',
                        });
                    } catch (err) {
                        reject(err);
                    }
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    async _refreshStatus() {
        try {
            const result = await this._execCommandAsync([TLP_STAT_BIN, '-s']);
            this._parseTlpStatOutput(result.stdout);
            this._updateUI();
        } catch (err) {
            if (!err.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                console.error(`[TLP Switcher] Failed to run tlp-stat -s: ${err.message}`);
            }
        }
    }

    _parseTlpStatOutput(output) {
        if (!output) {
            return;
        }

        const stateMatch = output.match(/^\s*State\s*=\s*(.+)$/m);
        const modeMatch = output.match(/^\s*Mode\s*=\s*(.+)$/m);
        const powerMatch = output.match(/^\s*Power source\s*=\s*(.+)$/m);
        const lastRunMatch = output.match(/^\s*Last run\s*=\s*(.+)$/m);

        const serviceState = stateMatch ? stateMatch[1].trim() : 'unknown';
        const rawMode = modeMatch ? modeMatch[1].trim() : 'unknown';
        const powerSource = powerMatch ? powerMatch[1].trim() : 'unknown';
        const lastRun = lastRunMatch ? lastRunMatch[1].trim() : 'unknown';

        const isManual = rawMode.includes('(manual)') || rawMode.includes('(persistent)');
        let mode = 'unknown';
        if (rawMode.toLowerCase().startsWith('ac')) {
            mode = 'AC';
        } else if (rawMode.toLowerCase().startsWith('battery')) {
            mode = 'battery';
        }

        this._state = {
            serviceState,
            mode,
            isManual,
            rawMode,
            powerSource,
            lastRun,
        };
    }

    _updateUI() {
        const { serviceState, mode, isManual, rawMode, powerSource } = this._state;

        this._panelLabel.remove_style_class_name('tlp-panel-ac-manual');
        this._panelLabel.remove_style_class_name('tlp-panel-bat-manual');

        if (this._isSwitching) {
            this._panelLabel.set_text('TLP...');
            return;
        }

        // Update Top Bar Icon & Label
        if (mode === 'AC') {
            this._panelIcon.icon_name = 'power-profile-performance-symbolic';
            if (isManual) {
                this._panelLabel.set_text('AC (Forced)');
                this._panelLabel.add_style_class_name('tlp-panel-ac-manual');
            } else {
                this._panelLabel.set_text('AC');
            }
        } else if (mode === 'battery') {
            this._panelIcon.icon_name = 'power-profile-power-saver-symbolic';
            if (isManual) {
                this._panelLabel.set_text('BAT (Forced)');
                this._panelLabel.add_style_class_name('tlp-panel-bat-manual');
            } else {
                this._panelLabel.set_text('BAT');
            }
        } else {
            // When TLP hasn't initialized a saved state yet, show physical power source hint
            this._panelIcon.icon_name = 'power-profile-balanced-symbolic';
            if (powerSource === 'AC') {
                this._panelLabel.set_text('TLP (AC)');
            } else if (powerSource === 'battery') {
                this._panelLabel.set_text('TLP (BAT)');
            } else {
                this._panelLabel.set_text('TLP');
            }
        }

        // Update Menu Status Labels
        this._modeStatusLabel.set_text(`Active Profile: ${rawMode}`);
        this._powerSourceLabel.set_text(`Physical Power: ${powerSource}`);
        this._serviceStateLabel.set_text(`TLP Service: ${serviceState}`);

        if (mode === 'AC' && isManual && powerSource.toLowerCase().includes('battery')) {
            this._overrideBannerLabel.set_text('⚡ High Performance forced on Battery');
            this._overrideBannerLabel.visible = true;
        } else if (mode === 'battery' && isManual && powerSource.toLowerCase().includes('ac')) {
            this._overrideBannerLabel.set_text('🍃 Battery Savings forced on AC Power');
            this._overrideBannerLabel.visible = true;
        } else {
            this._overrideBannerLabel.set_text('');
            this._overrideBannerLabel.visible = false;
        }

        // Update checkmarks (ornaments) on the 3 mode items
        this._acItem.setOrnament(
            mode === 'AC' && isManual
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE
        );
        this._batItem.setOrnament(
            mode === 'battery' && isManual
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE
        );
        this._autoItem.setOrnament(
            !isManual && (mode === 'AC' || mode === 'battery')
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE
        );
    }

    async _switchTlpMode(tlpSubcommand, friendlyName) {
        if (this._isSwitching) {
            return;
        }

        this._isSwitching = true;
        this._updateUI();

        try {
            // Try passwordless sudo first (configured by install.sh in /etc/sudoers.d/tlp-switcher)
            let res = await this._execCommandAsync(['sudo', '-n', TLP_BIN, tlpSubcommand]);

            if (!res.ok) {
                // Fallback to pkexec (uses /etc/polkit-1/rules.d/49-tlp-switcher.rules or prompts user)
                res = await this._execCommandAsync(['pkexec', TLP_BIN, tlpSubcommand]);
            }

            this._isSwitching = false;
            await this._refreshStatus();

            if (res.ok) {
                Main.notify(
                    'TLP Power Mode Switched',
                    `Active profile set to ${friendlyName} (Mode: ${this._state.rawMode})`
                );
            } else {
                const errDetail = res.stderr || res.stdout || `Exit code ${res.exitStatus}`;
                Main.notifyError(
                    'TLP Mode Switch Failed',
                    `Could not run "tlp ${tlpSubcommand}": ${errDetail}`
                );
            }
        } catch (err) {
            this._isSwitching = false;
            await this._refreshStatus();
            if (!err.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                Main.notifyError(
                    'TLP Mode Switch Error',
                    err.message
                );
            }
        }
    }

    destroy() {
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._pollTimeoutId) {
            GLib.Source.remove(this._pollTimeoutId);
            this._pollTimeoutId = null;
        }

        if (this._debounceTimeoutId) {
            GLib.Source.remove(this._debounceTimeoutId);
            this._debounceTimeoutId = null;
        }

        if (this._fileMonitor && this._fileMonitorChangedId) {
            this._fileMonitor.disconnect(this._fileMonitorChangedId);
            this._fileMonitor.cancel();
            this._fileMonitor = null;
            this._fileMonitorChangedId = null;
        }

        if (this.menu && this._menuOpenChangedId) {
            this.menu.disconnect(this._menuOpenChangedId);
            this._menuOpenChangedId = null;
        }

        this._settings = null;
        this._openPreferencesCallback = null;

        super.destroy();
    }
});

export default class TlpSwitcherExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._neverSleep = new NeverSleepController(this.uuid);
        this._indicator = new TlpIndicator(this._settings, () => this.openPreferences());

        const position = this._getValidPosition();
        const index = this._getInsertIndex(position);
        Main.panel.addToStatusArea(this.uuid, this._indicator, index, position);

        this._syncSessionModeVisibility();
        this._syncNeverSleep();

        this._posChangedId = this._settings.connect('changed::panel-position', () => {
            this._updatePanelPosition();
        });

        this._neverSleepChangedId = this._settings.connect('changed::never-sleep', () => {
            this._syncNeverSleep();
        });

        this._sessionModeUpdatedId = Main.sessionMode.connect('updated', () => {
            this._syncSessionModeVisibility();
        });
    }

    _syncSessionModeVisibility() {
        if (!this._indicator) {
            return;
        }

        if (Main.sessionMode.isLocked) {
            this._indicator.menu?.close();
            this._indicator.container.hide();
        } else {
            this._indicator.container.show();
        }
    }

    async _syncNeverSleep() {
        const enabled = this._settings?.get_boolean('never-sleep') ?? false;
        this._indicator?.updateNeverSleepUI();
        if (this._neverSleep) {
            const ok = await this._neverSleep.setEnabled(enabled);
            if (enabled && !ok && this._settings?.get_boolean('never-sleep')) {
                this._settings.set_boolean('never-sleep', false);
                Main.notifyError(
                    'TLP Switcher: Never Sleep Failed',
                    'Could not acquire system sleep/lid inhibitor.'
                );
            }
        }
    }

    _getValidPosition() {
        const pos = this._settings?.get_string('panel-position') || 'right';
        return ['left', 'center', 'right'].includes(pos) ? pos : 'right';
    }

    _getInsertIndex(position) {
        // On 'left', index 1 places the indicator right after the Activities button.
        // On 'center', index 1 places it right after the Date/Time menu.
        // On 'right', index 0 places it at the start of the right status box.
        return position === 'right' ? 0 : 1;
    }

    _updatePanelPosition() {
        if (!this._indicator) {
            return;
        }

        const position = this._getValidPosition();
        const index = this._getInsertIndex(position);
        const boxes = {
            left: Main.panel._leftBox,
            center: Main.panel._centerBox,
            right: Main.panel._rightBox,
        };
        const targetBox = boxes[position] || Main.panel._rightBox;

        const container = this._indicator.container;
        const parent = container.get_parent();

        if (parent !== targetBox) {
            this._indicator.menu?.close();
            if (parent) {
                parent.remove_child(container);
            }
            targetBox.insert_child_at_index(container, index);
        }

        this._indicator.updatePositionOrnament();
    }

    disable() {
        if (this._sessionModeUpdatedId) {
            Main.sessionMode.disconnect(this._sessionModeUpdatedId);
            this._sessionModeUpdatedId = null;
        }

        if (this._settings) {
            if (this._posChangedId) {
                this._settings.disconnect(this._posChangedId);
                this._posChangedId = null;
            }
            if (this._neverSleepChangedId) {
                this._settings.disconnect(this._neverSleepChangedId);
                this._neverSleepChangedId = null;
            }
            this._settings = null;
        }

        if (this._neverSleep) {
            this._neverSleep.destroy();
            this._neverSleep = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}

