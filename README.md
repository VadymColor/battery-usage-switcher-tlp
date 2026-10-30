# TLP Power Mode Switcher — Ubuntu GNOME Extension

A lightweight Ubuntu / GNOME Shell Top Bar extension (`tlp-switcher@local.extension`) for switching [TLP](https://linrunner.de/tlp/) power profiles on the fly — allowing you to **force High Performance (`tlp ac`) even when running on battery power**, force **Battery Savings (`tlp bat`)**, or return to **Automatic Mode (`tlp start`)**.

## Features

- **Top Bar Indicator**: Displays an icon and current TLP profile (`AC`, `AC (Forced)`, `BAT`, `BAT (Forced)`) directly in the Ubuntu top panel.
- **One-Click Mode Switching**:
  - **Force High Performance (`sudo tlp ac`)**: Applies the AC performance profile immediately, even when unplugged.
  - **Force Battery Savings (`sudo tlp bat`)**: Applies the battery-saving profile immediately.
  - **Automatic Mode (`sudo tlp start`)**: Re-evaluates the physical power supply and restores automatic profile switching.
- **Live Status Readout**: Parses `tlp-stat -s` and watches `/run/tlp` to display:
  - Active Profile (`AC`, `AC (manual)`, `battery`, `battery (manual)`)
  - Physical Power Source (`AC` / `battery`)
  - TLP Service State (`enabled` / `disabled`)
  - Visual banner when forcing High Performance on battery power.
- **Instant Passwordless Switching**: Includes a strictly scoped `sudoers` rule (`/etc/sudoers.d/tlp-switcher`) and Polkit rule (`/etc/polkit-1/rules.d/49-tlp-switcher.rules`) restricted solely to `/usr/sbin/tlp ac`, `/usr/sbin/tlp bat`, and `/usr/sbin/tlp start`.
- **Panel Position Settings (Left / Center / Right)**: Move the extension indicator between the **Right**, **Left**, or **Center** of the top bar directly from the indicator's popup menu (`Panel Position` submenu) or via the Extension Settings window (`gnome-extensions prefs tlp-switcher@local.extension`).
- **Never Sleep Mode (Keep Awake & Lid-Close Monitor Off)**: Toggle **Never Sleep** from the top bar menu or Extension Settings so your laptop stays awake and all background processes, music, and video playback remain active — while automatically switching off the laptop monitor (DPMS off) **only when the laptop lid is closed** and turning it right back on when opened.

## Project Structure

- `tlp-switcher@local.extension/metadata.json` — Extension manifest (supports GNOME Shell 45–50)
- `tlp-switcher@local.extension/extension.js` — Main indicator UI, menu, and async TLP subprocess controller
- `tlp-switcher@local.extension/neverSleep.js` — Never Sleep inhibitor & lid-close display DPMS controller
- `tlp-switcher@local.extension/prefs.js` — Libadwaita extension preferences window (Never Sleep & Panel Position settings)
- `tlp-switcher@local.extension/schemas/` — GSettings schema (`org.gnome.shell.extensions.tlp-switcher`)
- `tlp-switcher@local.extension/stylesheet.css` — Top bar and popup menu styling
- `sudoers/tlp-switcher` — Scoped passwordless sudo rule for `tlp ac|bat|start`
- `polkit/49-tlp-switcher.rules` — Fallback Polkit rule for `pkexec /usr/sbin/tlp`
- `install.sh` — Installer script
- `uninstall.sh` — Uninstaller script

## Installation

1. Make sure TLP is installed:
   ```bash
   sudo apt install tlp tlp-rdw
   ```

2. Run the installer script:
   ```bash
   ./install.sh
   ```
   *(If you prefer to be prompted for your password by `pkexec` every time you switch modes instead of installing the passwordless rule, run `./install.sh --no-sudo`.)*

3. Activate the extension in GNOME Shell:
   - **Wayland (Ubuntu default)**: Log out and log back in once so GNOME Shell discovers the new extension, then run:
     ```bash
     gnome-extensions enable tlp-switcher@local.extension
     ```
   - **X11**: Press `Alt+F2`, type `r`, press `Enter`, then run:
     ```bash
     gnome-extensions enable tlp-switcher@local.extension
     ```

## Uninstallation

```bash
./uninstall.sh
```

