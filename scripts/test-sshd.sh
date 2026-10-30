#!/usr/bin/env bash
# Starts a throwaway sshd for the live ssh tests, runs them, and tears it down. Touches nothing in ~/.ssh.
set -euo pipefail
D=$(mktemp -d); trap 'kill $(cat "$D/sshd.pid") 2>/dev/null; rm -rf "$D"' EXIT
PORT=${1:-2299}
ssh-keygen -q -t ed25519 -N '' -f "$D/hostkey"; ssh-keygen -q -t ed25519 -N '' -f "$D/clientkey"
cp "$D/clientkey.pub" "$D/authorized_keys"; chmod 600 "$D/authorized_keys"
cat > "$D/sshd_config" <<CFG
Port $PORT
ListenAddress 127.0.0.1
HostKey $D/hostkey
AuthorizedKeysFile $D/authorized_keys
PidFile $D/sshd.pid
PasswordAuthentication no
UsePAM no
StrictModes no
Subsystem sftp internal-sftp
CFG
/usr/sbin/sshd -f "$D/sshd_config" -E "$D/sshd.log"; sleep 1
MCONTROLPROGRAM_TEST_SSH_PORT=$PORT MCONTROLPROGRAM_TEST_SSH_KEY="$D/clientkey" MCONTROLPROGRAM_TEST_SSH_AUTHORIZED_KEYS="$D/authorized_keys" node --test --import tsx 'test/ssh-live.test.ts'
