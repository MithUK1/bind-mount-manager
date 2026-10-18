#!/bin/bash
# Builds BindMountManager-<version>.spk from pkg/ (package.tgz contents) and spk/ (package metadata).
set -euo pipefail
cd "$(dirname "$0")"

version=$(sed -n 's/^version="\(.*\)"/\1/p' spk/INFO)
out="BindMountManager-${version}.spk"

tar --owner=0 --group=0 --numeric-owner -czf spk/package.tgz -C pkg ui bin
sum=$(md5sum spk/package.tgz | cut -d' ' -f1)
sed -i "s/^checksum=.*/checksum=\"${sum}\"/" spk/INFO

rm -f "$out"
(cd spk && tar --owner=0 --group=0 --numeric-owner -cf "../${out}" \
  INFO PACKAGE_ICON.PNG PACKAGE_ICON_256.PNG conf scripts WIZARD_UIFILES package.tgz)
rm -f spk/package.tgz
echo "Built ${out}"
