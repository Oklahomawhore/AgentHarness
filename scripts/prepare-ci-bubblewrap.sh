#!/usr/bin/env bash
set -euo pipefail

# Ubuntu's signed package indexes resolve supported updates without retaining a
# superseded .deb URL. The probe must succeed before sandbox-dependent gates run.
sudo apt-get update -q
sudo apt-get install --no-install-recommends -yq bubblewrap
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
bwrap --version
bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true
echo 'bubblewrap functional probe passed'
