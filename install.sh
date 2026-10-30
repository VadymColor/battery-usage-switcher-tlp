#!/usr/bin/env bash
set -euo pipefail

UUID="tlp-switcher@local.extension"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_SRC_DIR="${SCRIPT_DIR}/${UUID}"

# Determine target user and home directory even if script is invoked with sudo
TARGET_USER="${SUDO_USER:-$USER}"
TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"
EXT_DEST_DIR="${TARGET_HOME}/.local/share/gnome-shell/extensions/${UUID}"

echo "=== Installing TLP Power Mode Switcher (${UUID}) ==="

# 1. Check TLP installation
if ! command -v tlp >/dev/null 2>&1 || ! command -v tlp-stat >/dev/null 2>&1; then
    echo "Warning: 'tlp' or 'tlp-stat' was not found in PATH."
    echo "Install TLP with: sudo apt install tlp tlp-rdw"
fi

# 2. Install GNOME Shell Extension files into user's extension directory
echo "-> Copying extension files to: ${EXT_DEST_DIR}"
mkdir -p "${EXT_DEST_DIR}/schemas"
cp -f "${EXT_SRC_DIR}/metadata.json" "${EXT_DEST_DIR}/metadata.json"
cp -f "${EXT_SRC_DIR}/extension.js" "${EXT_DEST_DIR}/extension.js"
cp -f "${EXT_SRC_DIR}/neverSleep.js" "${EXT_DEST_DIR}/neverSleep.js"
cp -f "${EXT_SRC_DIR}/prefs.js" "${EXT_DEST_DIR}/prefs.js"
cp -f "${EXT_SRC_DIR}/stylesheet.css" "${EXT_DEST_DIR}/stylesheet.css"
cp -rf "${EXT_SRC_DIR}/schemas/"* "${EXT_DEST_DIR}/schemas/"

if command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas "${EXT_DEST_DIR}/schemas"
fi

if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
    chown -R "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.local/share/gnome-shell"
fi

# 3. Install passwordless sudoers & Polkit rules for 'tlp ac', 'tlp bat', 'tlp start'
if [ "${1:-}" != "--no-sudo" ]; then
    echo "-> Configuring passwordless permission for: tlp ac, tlp bat, tlp start"
    TMP_SUDOERS="$(mktemp)"
    cat <<EOF > "${TMP_SUDOERS}"
# Allow passwordless switching of TLP power modes (ac, bat, start)
%sudo ALL=(root) NOPASSWD: /usr/sbin/tlp ac, /usr/sbin/tlp bat, /usr/sbin/tlp start
${TARGET_USER} ALL=(root) NOPASSWD: /usr/sbin/tlp ac, /usr/sbin/tlp bat, /usr/sbin/tlp start
EOF
    chmod 0440 "${TMP_SUDOERS}"

    if sudo visudo -cf "${TMP_SUDOERS}" >/dev/null 2>&1; then
        sudo cp "${TMP_SUDOERS}" /etc/sudoers.d/tlp-switcher
        sudo chown root:root /etc/sudoers.d/tlp-switcher
        sudo chmod 0440 /etc/sudoers.d/tlp-switcher
        echo "   Installed /etc/sudoers.d/tlp-switcher"
    else
        echo "   Warning: visudo validation failed; skipping /etc/sudoers.d/tlp-switcher"
    fi
    rm -f "${TMP_SUDOERS}"

    if [ -d /etc/polkit-1/rules.d ] || sudo test -d /etc/polkit-1/rules.d; then
        sudo cp "${SCRIPT_DIR}/polkit/49-tlp-switcher.rules" /etc/polkit-1/rules.d/49-tlp-switcher.rules
        sudo chmod 0644 /etc/polkit-1/rules.d/49-tlp-switcher.rules
        echo "   Installed /etc/polkit-1/rules.d/49-tlp-switcher.rules"
    fi
else
    echo "-> Skipping sudoers/polkit installation (--no-sudo passed)."
fi

# 4. Enable the extension
echo "-> Enabling extension ${UUID}..."
if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions enable "${UUID}" 2>/dev/null || true
fi

echo ""
echo "=== Installation Complete! ==="
echo "Note: On Ubuntu (Wayland), if this is the first time installing the extension,"
echo "log out and log back in (or press Alt+F2 -> 'r' -> Enter on X11), then run:"
echo "  gnome-extensions enable ${UUID}"

