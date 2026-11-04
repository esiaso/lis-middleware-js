#!/bin/sh
# Install or upgrade the LIMS middleware from an extracted release bundle (11 §4).
# Run as root from the bundle directory:  sudo ./scripts/install.sh
# It does NOT start or restart any service, and never touches the database.
set -eu

BUNDLE=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
PREFIX=${LIMS_PREFIX:-/opt/lims}
ETC=${LIMS_ETC:-/etc/lims}
UNITS=${LIMS_UNIT_DIR:-/etc/systemd/system}
SVC_USER=lims-svc

die() { echo "install: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root"
command -v sha256sum >/dev/null || die "sha256sum is required"

echo "Checking the bundle against SHA256SUMS..."
(cd "$BUNDLE" && sha256sum --quiet --strict -c SHA256SUMS) || die "checksum mismatch: do not install this copy"

VERSION=$("$BUNDLE/runtime/node/bin/node" -e 'process.stdout.write(require(process.argv[1]).version)' "$BUNDLE/manifest.json")
TARGET="$PREFIX/$VERSION"
echo "Installing version $VERSION to $TARGET"

if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /var/lib/lims --shell /usr/sbin/nologin "$SVC_USER"
fi
getent group dialout >/dev/null && usermod -a -G dialout "$SVC_USER" || true

install -d -m 0755 "$PREFIX"
if [ "$BUNDLE" != "$TARGET" ]; then
  [ -e "$TARGET" ] && die "$TARGET already exists; remove it first if you mean to reinstall the same version"
  cp -a "$BUNDLE" "$TARGET"
fi
chown -R root:root "$TARGET"
chmod -R go-w "$TARGET"

install -d -m 0750 -o root -g "$SVC_USER" "$ETC"
install -d -m 0700 -o root -g root "$ETC/secrets"
install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" /var/lib/lims /var/log/lims
[ -e "$ETC/lims.env" ] || install -m 0640 -o root -g "$SVC_USER" "$TARGET/config/lims.env.example" "$ETC/lims.env"

for unit in lims-web.service lims-jobs.service lims-analyzer@.service; do
  install -m 0644 "$TARGET/service/$unit" "$UNITS/$unit"
done
if command -v systemctl >/dev/null && systemctl daemon-reload 2>/dev/null; then :; else echo "note: run systemctl daemon-reload once systemd is running"; fi

# Switch "current" last, so a failed install leaves the running version alone.
ln -sfn "$TARGET" "$PREFIX/current.new"
mv -Tf "$PREFIX/current.new" "$PREFIX/current"
ln -sfn "$PREFIX/current/bin/lims" /usr/local/bin/lims
ln -sfn "$PREFIX/current/bin/lims-web" /usr/local/bin/lims-web

cat <<EOF

Installed $VERSION. Nothing was started. Next (11 §3 steps 3 to 8):
  1. lims secrets set database_url   (piped in, or typed unseen)
  2. Review $ETC/lims.env, then: lims config validate
  3. lims db migrate
  4. lims-web create-user <username> "<display name>" admin < password-file   (first install only)
  5. lims verify --out /var/log/lims
  6. systemctl enable --now lims-jobs lims-web
     then for each instrument registered on the screens: systemctl enable --now lims-analyzer@<instrument-id>
On an upgrade, stop the services before step 3 and start them after step 5 (11 §9).
EOF
