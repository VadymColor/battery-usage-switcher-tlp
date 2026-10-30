import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const POSITIONS = [
    { value: 'right', label: 'Right' },
    { value: 'left', label: 'Left' },
    { value: 'center', label: 'Center' },
];

export default class TlpSwitcherPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });

        // 1. Sleep & Lid Behavior Group
        const sleepGroup = new Adw.PreferencesGroup({
            title: 'Sleep & Lid Behavior',
            description: 'Keep your laptop awake and running even when the lid is closed.',
        });

        const neverSleepRow = new Adw.SwitchRow({
            title: 'Never Sleep Mode',
            subtitle: 'Keep all processes, music, and video active; switch off monitor only when laptop lid is closed',
        });

        settings.bind(
            'never-sleep',
            neverSleepRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        sleepGroup.add(neverSleepRow);
        page.add(sleepGroup);

        // 2. Panel Appearance Group
        const appearanceGroup = new Adw.PreferencesGroup({
            title: 'Panel Appearance',
            description: 'Configure where the TLP indicator appears on the top bar.',
        });

        const positionModel = new Gtk.StringList();
        for (const item of POSITIONS) {
            positionModel.append(item.label);
        }

        const positionRow = new Adw.ComboRow({
            title: 'Panel Position',
            subtitle: 'Move the extension indicator between the right, left, or center of the top panel',
            model: positionModel,
        });

        const syncSelectedFromSettings = () => {
            const currentPos = settings.get_string('panel-position');
            const idx = POSITIONS.findIndex(item => item.value === currentPos);
            const targetIdx = idx >= 0 ? idx : 0;
            if (positionRow.get_selected() !== targetIdx) {
                positionRow.set_selected(targetIdx);
            }
        };

        syncSelectedFromSettings();

        positionRow.connect('notify::selected', widget => {
            const selectedItem = POSITIONS[widget.get_selected()];
            if (selectedItem && settings.get_string('panel-position') !== selectedItem.value) {
                settings.set_string('panel-position', selectedItem.value);
            }
        });

        const settingsChangedId = settings.connect('changed::panel-position', () => {
            syncSelectedFromSettings();
        });

        window.connect('close-request', () => {
            settings.disconnect(settingsChangedId);
        });

        appearanceGroup.add(positionRow);
        page.add(appearanceGroup);

        window.add(page);
    }
}
