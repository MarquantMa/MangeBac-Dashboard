#!/bin/bash
set -euo pipefail

APP_NAME="ManageBac Student Dashboard"
LINUX_SERVICE_NAME="managebac-dashboard.service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PATH="${SCRIPT_DIR}/server.py"
PYTHON_BIN="$(command -v python3 || true)"

print_header() {
    echo "==================================================="
    echo "  ${APP_NAME} User Startup Installer"
    echo "==================================================="
    echo ""
}

die() {
    echo "Error: $*" >&2
    exit 1
}

systemd_quote() {
    local escaped
    escaped="$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
    printf '"%s"' "$escaped"
}

validate_environment() {
    [ -n "$PYTHON_BIN" ] || die "python3 was not found. Install Python 3 first."
    [ -f "$SERVER_PATH" ] || die "server.py was not found next to this script."
}

install_linux_user_service() {
    local service_dir service_path python_arg server_arg workdir_arg

    [ "$(uname -s)" = "Linux" ] || die "this installer only supports Linux."
    command -v systemctl >/dev/null 2>&1 || die "systemctl was not found. This installer expects systemd user services on Linux."
    systemctl --user show-environment >/dev/null 2>&1 || die "systemd --user is not available in this session."

    service_dir="${HOME}/.config/systemd/user"
    service_path="${service_dir}/${LINUX_SERVICE_NAME}"

    mkdir -p "$service_dir"

    python_arg="$(systemd_quote "$PYTHON_BIN")"
    server_arg="$(systemd_quote "$SERVER_PATH")"
    workdir_arg="$(systemd_quote "$SCRIPT_DIR")"

    cat > "$service_path" <<EOF
[Unit]
Description=${APP_NAME} backend

[Service]
Type=simple
WorkingDirectory=${workdir_arg}
ExecStart=${python_arg} ${server_arg}
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=default.target
EOF

    systemctl --user daemon-reload
    systemctl --user enable --now "$LINUX_SERVICE_NAME"

    echo "Installed user systemd service:"
    echo "  ${service_path}"
    echo "Status:"
    systemctl --user --no-pager --full status "$LINUX_SERVICE_NAME" || true
}

main() {
    print_header
    validate_environment
    install_linux_user_service

    echo ""
    echo "The backend is configured to start for this user and listen on:"
    echo "  http://localhost:8082"
}

main "$@"
