#!/usr/bin/env bash
set -euo pipefail

UUID="tlp-switcher@local.extension"
TARGET_USER="${SUDO_USER:-$USER}"
TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"
EXT_DEST_DIR="${TARGET_HOME}/.local/share/gnome-shell/extensions/${UUID}"

echo "=== Uninstalling TLP Power Mode Switcher (${UUID}) ==="

if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions disable "${UUID}" 2>/dev/null || true
fi

if [ -d "${EXT_DEST_DIR}" ]; then
    rm -rf "${EXT_DEST_DIR}"
    echo "-> Removed ${EXT_DEST_DIR}"
fi

if [ "${1:-}" != "--no-sudo" ]; then
    if [ -f /etc/sudoers.d/tlp-switcher ]; then
        sudo rm -f /etc/sudoers.d/tlp-switcher
        echo "-> Removed /etc/sudoers.d/tlp-switcher"
    fi

    if [ -f /etc/polkit-1/rules.d/49-tlp-switcher.rules ]; then
        sudo rm -f /etc/polkit-1/rules.d/49-tlp-switcher.rules
        echo "-> Removed /etc/polkit-1/rules.d/49-tlp-switcher.rules"
    fi
fi

echo "=== Uninstallation Complete ==="

