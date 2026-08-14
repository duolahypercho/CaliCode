#!/usr/bin/env bash
# Create the local code-signing identity CaliCode's dev builds use.
#
# Why this exists: an ad-hoc signature is keyed to the binary's hash, so macOS
# sees every rebuild as a brand-new app and drops the TCC grants that let it
# read ~/Desktop, ~/Documents and ~/Downloads. That means re-approving after
# every build — and worse, a shell spawned in a folder the app no longer has
# access to blocks forever inside getcwd() instead of failing, which is how a
# terminal ends up alive but permanently silent.
#
# Signing with a stable certificate keys the grant to the identity instead of
# the hash, so approving once holds across rebuilds. The certificate is
# self-signed and local: it is for keeping TCC happy on this machine, NOT for
# distribution. Shipping to other people still needs a Developer ID.
#
#   scripts/dev-signing-identity.sh            # create it
#   scripts/dev-signing-identity.sh --remove   # undo
set -euo pipefail

NAME="${CALI_SIGNING_IDENTITY:-CaliCode Dev}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "macOS only; nothing to do." >&2
  exit 0
fi

if [ "${1:-}" = "--remove" ]; then
  security delete-identity -c "$NAME" "$KEYCHAIN" 2>/dev/null || true
  security delete-certificate -c "$NAME" "$KEYCHAIN" 2>/dev/null || true
  echo "Removed \"$NAME\". Builds fall back to ad-hoc signing."
  exit 0
fi

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$NAME"; then
  echo "\"$NAME\" already exists — nothing to do."
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $NAME
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/cert.cnf" >/dev/null 2>&1

# `security` rejects OpenSSL 3's default PKCS12 algorithms, so the bundle is
# written with the older SHA1/3DES pair it can actually read.
openssl pkcs12 -export -macalg sha1 -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES \
  -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$NAME" \
  -out "$WORK/identity.p12" -passout pass:calicode >/dev/null 2>&1

security import "$WORK/identity.p12" -k "$KEYCHAIN" -T /usr/bin/codesign -P calicode >/dev/null
# Self-signed certificates are not trusted for code signing until told to be;
# scoped to this login keychain and to codeSign use only.
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$WORK/cert.pem"

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$NAME"; then
  echo "Created \"$NAME\". Rebuild, approve folder access once, and it will stick."
else
  echo "Import succeeded but \"$NAME\" is not a valid signing identity." >&2
  exit 1
fi
