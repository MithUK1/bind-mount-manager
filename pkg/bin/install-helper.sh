#!/bin/bash
# Bind Mount Manager - helper installer
#
# Run as root by the boot-up task in DSM Task Scheduler:
#   /bin/bash /var/packages/BindMountManager/target/bin/install-helper.sh
#
# The first run copies the helper to a root-owned location so that later boots
# only run a file that the package user cannot modify, then starts it.
# To update the helper after upgrading the package, run once with --force.

PKG="BindMountManager"
SRC="${BMM_SRC:-/var/packages/$PKG/target/bin/bmm-helper.sh}"
DST="/usr/local/bin/bmm-helper"

if [ "$(id -u)" != "0" ]; then
  echo "This must run as root (use a Task Scheduler task with User: root)."
  exit 1
fi

if [ ! -d "/var/packages/$PKG" ]; then
  echo "Bind Mount Manager is not installed any more, nothing to do."
  exit 0
fi

# Also refresh the installed copy after a package upgrade, but only from a package file
# that is owned by root and not writable by anyone else.
NEWER=0
if [ -x "$DST" ] && [ -f "$SRC" ] && ! cmp -s "$SRC" "$DST"; then
  OWN=$(stat -c '%u' "$SRC" 2>/dev/null)
  MODE=$(stat -c '%A' "$SRC" 2>/dev/null)
  if [ "$OWN" = "0" ] && [ "${MODE:5:1}" != "w" ] && [ "${MODE:8:1}" != "w" ]; then NEWER=1; fi
fi

if [ ! -x "$DST" ] || [ "$1" = "--force" ] || [ "$NEWER" = "1" ]; then
  if [ ! -f "$SRC" ]; then
    echo "Package files not found at $SRC"
    exit 1
  fi
  mkdir -p /usr/local/bin
  cp -f "$SRC" "$DST.new" || exit 1
  chown root:root "$DST.new"
  chmod 755 "$DST.new"
  mv -f "$DST.new" "$DST"
  echo "Helper installed to $DST"
  if [ "$1" = "--force" ] || [ "$NEWER" = "1" ]; then
    "$DST" restart
    exit 0
  fi
fi

"$DST" start
