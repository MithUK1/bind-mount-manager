#!/bin/bash
# Bind Mount Manager - root helper
#
# DSM 7 does not let third party packages run as root, and mounting needs root.
# This small helper is started once at boot by a Task Scheduler task (see
# install-helper.sh). It reads the mounts configured in the app web page and
# applies them with "mount --bind", and it answers folder browsing requests
# from the web page. Everything it is asked to do is validated here, as root.
#
# Usage: bmm-helper {start|stop|restart|status|run}

HELPER_VERSION="1.0.0"

PKG="BindMountManager"
PKGDIR="/var/packages/$PKG"
VARDIR="$PKGDIR/var"
CONF="$VARDIR/mounts.conf"
SPOOL="$VARDIR/spool"
RUN="/run/bindmountmanager"
STATEF="$RUN/state.tsv"
ACTIVEF="$RUN/active.tsv"
HBF="$RUN/heartbeat"
PIDF="$RUN/helper.pid"
MPF="$RUN/mountpoints.txt"
LOGF="$RUN/helper.log"

umask 022
export PATH=/usr/syno/sbin:/usr/syno/bin:/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

declare -A ASRC ATGT ARO FAILS
NEWSTATE=""
USED=$'\n'
RETRY=0
RSTATE="error"
RMSG=""
RSRC=""
RTGT=""

log() {
  logger -t BindMountManager -- "$*" 2>/dev/null
  mkdir -p "$RUN" 2>/dev/null
  printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOGF" 2>/dev/null
}

jesc() {
  local s="$1"
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//[[:cntrl:]]/?}
  printf '%s' "$s"
}

# Syntax check for a path coming from the config or a request.
valid_path() {
  local p="$1"
  [[ "$p" =~ ^/volume[A-Za-z0-9]+(/[^/]+)+$ ]] || return 1
  [[ "$p" =~ [[:cntrl:]] ]] && return 1
  [[ "$p" == *\\* ]] && return 1
  case "/$p/" in
    */../*|*/./*|*/@*|*/\#*) return 1 ;;
  esac
  return 0
}

# Number of folders below the volume: /volume1/data = 1, /volume1/data/x = 2
depth_of() {
  local t="${1//[^\/]/}"
  echo $(( ${#t} - 1 ))
}

load_mountpoints() {
  local mp
  : > "$MPF"
  while IFS=' ' read -r _ _ _ _ mp _; do
    printf '%b\n' "$mp" >> "$MPF"
  done < /proc/self/mountinfo
}

is_mounted() {
  grep -qxF -- "$1" "$MPF" 2>/dev/null
}

load_active() {
  ASRC=(); ATGT=(); ARO=()
  [ -f "$ACTIVEF" ] || return 0
  local id s t r
  while IFS=$'\t' read -r id s t r || [ -n "$id" ]; do
    [[ "$id" =~ ^m[0-9]+$ ]] || continue
    ASRC[$id]=$s
    ATGT[$id]=$t
    ARO[$id]=${r:-0}
  done < "$ACTIVEF"
}

save_active() {
  local id out=""
  for id in "${!ATGT[@]}"; do
    out+="$id"$'\t'"${ASRC[$id]}"$'\t'"${ATGT[$id]}"$'\t'"${ARO[$id]:-0}"$'\n'
  done
  printf '%s' "$out" > "$ACTIVEF.tmp" && mv -f "$ACTIVEF.tmp" "$ACTIVEF"
}

set_state() {
  NEWSTATE+="$1"$'\t'"$2"$'\t'"$3"$'\n'
  case "$2" in waiting|error) RETRY=1 ;; esac
}

write_state() {
  printf '%s' "$NEWSTATE" > "$STATEF.tmp" && mv -f "$STATEF.tmp" "$STATEF"
  chmod 644 "$STATEF" 2>/dev/null
}

remount_mode() {
  # $1 target, $2 1 = read only, 0 = read write
  if [[ "$2" == 1 ]]; then
    mount -o remount,bind,ro "$1" 2>/dev/null
  else
    mount -o remount,bind,rw "$1" 2>/dev/null
  fi
}

do_umount() {
  local id="$1" t="${ATGT[$id]}"
  [[ -z "$t" ]] && return 0
  if ! is_mounted "$t"; then
    unset -v 'ASRC[$id]' 'ATGT[$id]' 'ARO[$id]' 'FAILS[$id]'
    return 0
  fi
  valid_path "$t" || return 1
  if umount "$t" 2>/dev/null; then
    grep -vxF -- "$t" "$MPF" > "$MPF.tmp" 2>/dev/null; mv -f "$MPF.tmp" "$MPF" 2>/dev/null
    unset -v 'ASRC[$id]' 'ATGT[$id]' 'ARO[$id]' 'FAILS[$id]'
    return 0
  fi
  FAILS[$id]=$(( ${FAILS[$id]:-0} + 1 ))
  if (( FAILS[$id] >= 3 )) && umount -l "$t" 2>/dev/null; then
    grep -vxF -- "$t" "$MPF" > "$MPF.tmp" 2>/dev/null; mv -f "$MPF.tmp" "$MPF" 2>/dev/null
    log "Lazy unmount used for a folder that stayed busy"
    unset -v 'ASRC[$id]' 'ATGT[$id]' 'ARO[$id]' 'FAILS[$id]'
    return 0
  fi
  return 1
}

# Checks one config entry. On success sets RSRC and RTGT (resolved paths).
resolve_entry() {
  local src="$1" tgt="$2"
  RSTATE="error"; RMSG=""
  valid_path "$src" || { RMSG="The source path is not allowed"; return 1; }
  valid_path "$tgt" || { RMSG="The target path is not allowed"; return 1; }
  if [ ! -d "$src" ]; then RSTATE="waiting"; RMSG="Source folder not found yet. Will keep trying"; return 1; fi
  if [ ! -d "$tgt" ]; then RSTATE="waiting"; RMSG="Target folder not found yet. Will keep trying"; return 1; fi
  RSRC=$(readlink -f -- "$src")
  RTGT=$(readlink -f -- "$tgt")
  if ! valid_path "$RSRC" || ! valid_path "$RTGT"; then
    RMSG="A folder resolves to a location outside your volumes"; return 1
  fi
  (( $(depth_of "$RSRC") >= 1 )) || { RMSG="Source must be a folder on a volume"; return 1; }
  (( $(depth_of "$RTGT") >= 1 )) || { RMSG="Target must be a shared folder or a folder inside one"; return 1; }
  [[ "$RSRC" == "$RTGT" ]] && { RMSG="Source and target are the same folder"; return 1; }
  [[ "$RTGT/" == "$RSRC/"* ]] && { RMSG="Target is inside the source folder"; return 1; }
  [[ "$RSRC/" == "$RTGT/"* ]] && { RMSG="Source is inside the target folder"; return 1; }
  return 0
}

handle_entry() {
  local id="$1" en="$2" ro="$3" src="$4" tgt="$5" err hidden=0

  if [[ "$en" == 0 ]]; then
    if [[ -n "${ATGT[$id]}" ]]; then
      if ! do_umount "$id"; then
        set_state "$id" error "Could not switch off, the folder is in use. Retrying"
        return
      fi
      log "Switched off mount $id"
    fi
    set_state "$id" disabled "Switched off"
    return
  fi

  if ! resolve_entry "$src" "$tgt"; then
    set_state "$id" "$RSTATE" "$RMSG"
    return
  fi

  if [[ "$USED" == *$'\n'"$RTGT"$'\n'* ]]; then
    set_state "$id" error "Another mount already uses this target folder"
    return
  fi
  USED+="$RTGT"$'\n'

  # Entry was edited while mounted: release the old mount first
  if [[ -n "${ATGT[$id]}" ]] && { [[ "${ATGT[$id]}" != "$RTGT" ]] || [[ "${ASRC[$id]}" != "$RSRC" ]]; }; then
    if ! do_umount "$id"; then
      set_state "$id" error "Could not release the old mount, the folder is in use. Retrying"
      return
    fi
  fi

  # Our record says mounted but the mount is gone (someone unmounted it)
  if [[ -n "${ATGT[$id]}" ]] && ! is_mounted "${ATGT[$id]}"; then
    unset -v 'ASRC[$id]' 'ATGT[$id]' 'ARO[$id]'
  fi

  if [[ -n "${ATGT[$id]}" ]]; then
    if [[ "${ARO[$id]}" != "$ro" ]]; then
      remount_mode "$RTGT" "$ro" && ARO[$id]=$ro
    fi
    if [[ "${ARO[$id]}" == 1 ]]; then set_state "$id" mounted "Active (read only)"; else set_state "$id" mounted "Active"; fi
    return
  fi

  # Something is already mounted there (for example an older boot script): adopt it
  if is_mounted "$RTGT"; then
    ASRC[$id]=$RSRC; ATGT[$id]=$RTGT; ARO[$id]=0
    if [[ "$ro" == 1 ]] && remount_mode "$RTGT" 1; then ARO[$id]=1; fi
    set_state "$id" mounted "Active (it was already mounted)"
    return
  fi

  # DSM's own @eaDir and #recycle folders do not count as files
  [ -n "$(ls -A -- "$RTGT" 2>/dev/null | grep -v '^[@#]' | head -n 1)" ] && hidden=1

  # Mounting straight onto a whole shared folder hides everything in it, so only allow an empty one
  # (DSM's own @eaDir and #recycle folders do not count).
  if (( $(depth_of "$RTGT") == 1 )) && [ -n "$(ls -A -- "$RTGT" 2>/dev/null | grep -v '^[@#]' | head -n 1)" ]; then
    set_state "$id" error "That shared folder is not empty. Empty it first, or use a new shared folder"
    return
  fi

  if err=$(mount --bind "$RSRC" "$RTGT" 2>&1); then
    ASRC[$id]=$RSRC; ATGT[$id]=$RTGT; ARO[$id]=0
    echo "$RTGT" >> "$MPF"
    if [[ "$ro" == 1 ]] && remount_mode "$RTGT" 1; then ARO[$id]=1; fi
    log "Mounted $RSRC on $RTGT"
    if (( hidden )); then
      set_state "$id" mounted "Active. The target folder already had files, they are hidden while this is on"
    elif [[ "$ro" == 1 ]]; then
      set_state "$id" mounted "Active (read only)"
    else
      set_state "$id" mounted "Active"
    fi
  else
    log "Mount failed for $id: $err"
    set_state "$id" error "The mount failed. Check the helper log in $RUN"
  fi
}

reconcile() {
  local id en ro src tgt have_conf=0
  declare -A CFG=()
  load_mountpoints
  load_active
  NEWSTATE=""
  USED=$'\n'
  RETRY=0

  if [ -f "$CONF" ] && [ ! -L "$CONF" ]; then
    have_conf=1
    while IFS=$'\t' read -r id en ro src tgt || [ -n "$id" ]; do
      [[ "$id" =~ ^m[0-9]+$ ]] || continue
      [[ "$en" == 0 || "$en" == 1 ]] || continue
      [[ "$ro" == 0 || "$ro" == 1 ]] || continue
      [ -n "$src" ] && [ -n "$tgt" ] || continue
      CFG[$id]=1
      handle_entry "$id" "$en" "$ro" "$src" "$tgt"
    done < "$CONF"
  fi

  # Entries that were removed in the app: unmount them
  if (( have_conf )); then
    for id in "${!ATGT[@]}"; do
      if [[ -z "${CFG[$id]}" ]]; then
        if do_umount "$id"; then log "Unmounted removed entry $id"; else RETRY=1; fi
      fi
    done
  fi

  save_active
  write_state
}

# ---- Requests from the web page (folder browser, new folder) ----

req_error() {
  printf '{"ok":false,"error":"%s"}' "$(jesc "$1")"
}

req_browse() {
  local p="${1%/}" rp parent d name entries="" sep="" count=0 mounted empty depth

  if [[ -z "$p" ]]; then
    for d in /volume*; do
      [[ "$d" =~ ^/volume[A-Za-z0-9]+$ ]] || continue
      [ -d "$d" ] && [ ! -L "$d" ] || continue
      entries+="$sep{\"name\":\"$(jesc "${d#/}")\",\"mounted\":false,\"empty\":null}"
      sep=","
    done
    printf '{"ok":true,"path":"","parent":null,"depth":0,"entries":[%s]}' "$entries"
    return
  fi

  if [[ "$p" =~ ^/volume[A-Za-z0-9]+$ ]]; then
    # a volume itself: listing it is fine, mounting on it is not (checked elsewhere)
    [ -d "$p" ] && [ ! -L "$p" ] || { req_error "Folder not found"; return; }
    rp="$p"
  else
    valid_path "$p" || { req_error "That path is not allowed"; return; }
    [ -d "$p" ] || { req_error "Folder not found"; return; }
    rp=$(readlink -f -- "$p")
    valid_path "$rp" || { req_error "That path is not allowed"; return; }
  fi
  depth=$(depth_of "$rp")
  parent="${rp%/*}"
  load_mountpoints

  for d in "$rp"/*/; do
    d="${d%/}"
    [ -d "$d" ] && [ ! -L "$d" ] || continue
    name="${d##*/}"
    case "$name" in @*|\#*) continue ;; esac
    count=$((count + 1))
    (( count > 500 )) && break
    if is_mounted "$d"; then mounted=true; else mounted=false; fi
    if (( count <= 100 )); then
      if [ -n "$(ls -A -- "$d" 2>/dev/null | head -n 1)" ]; then empty=false; else empty=true; fi
    else
      empty=null
    fi
    entries+="$sep{\"name\":\"$(jesc "$name")\",\"mounted\":$mounted,\"empty\":$empty}"
    sep=","
  done
  printf '{"ok":true,"path":"%s","parent":"%s","depth":%s,"entries":[%s]}' \
    "$(jesc "$rp")" "$(jesc "$parent")" "$depth" "$entries"
}

req_mkdir() {
  local p="${1%/}" name="$2" rp
  valid_path "$p" || { req_error "That path is not allowed"; return; }
  [ -d "$p" ] || { req_error "Folder not found"; return; }
  rp=$(readlink -f -- "$p")
  valid_path "$rp" || { req_error "That path is not allowed"; return; }
  (( $(depth_of "$rp") >= 1 )) || { req_error "Open a shared folder first"; return; }
  if [[ -z "$name" || ${#name} -gt 100 || "$name" == "." || "$name" == ".." \
        || "$name" == */* || "$name" == *\\* || "$name" =~ [[:cntrl:]] \
        || "$name" == @* || "$name" == \#* ]]; then
    req_error "That folder name is not allowed"; return
  fi
  [ -e "$rp/$name" ] && { req_error "A folder with that name already exists"; return; }
  if mkdir -- "$rp/$name" 2>/dev/null; then
    chmod 755 -- "$rp/$name" 2>/dev/null
    log "Created folder $rp/$name"
    printf '{"ok":true,"path":"%s"}' "$(jesc "$rp/$name")"
  else
    req_error "Could not create the folder"
  fi
}

process_requests() {
  local f rid cmd path name line k v size
  for f in "$SPOOL"/req.*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    rid="${f##*/req.}"
    if ! [[ "$rid" =~ ^[a-z0-9]{6,32}$ ]] || [ -L "$f" ] || [ ! -f "$f" ]; then
      rm -f -- "$f"; continue
    fi
    size=$(wc -c < "$f" 2>/dev/null)
    if [ "${size:-0}" -gt 2048 ]; then rm -f -- "$f"; continue; fi
    cmd=""; path=""; name=""
    while IFS= read -r line || [ -n "$line" ]; do
      k="${line%%=*}"; v="${line#*=}"
      case "$k" in
        cmd) cmd="$v" ;;
        path) path="$v" ;;
        name) name="$v" ;;
      esac
    done < "$f"
    rm -f -- "$f"
    case "$cmd" in
      browse) req_browse "$path" > "$RUN/.res.$rid.tmp" ;;
      mkdir)  req_mkdir "$path" "$name" > "$RUN/.res.$rid.tmp" ;;
      *)      req_error "Unknown request" > "$RUN/.res.$rid.tmp" ;;
    esac
    chmod 644 "$RUN/.res.$rid.tmp" 2>/dev/null
    mv -f -- "$RUN/.res.$rid.tmp" "$RUN/res.$rid"
  done
}

cleanup_results() {
  local f
  ls -1t "$RUN"/res.* 2>/dev/null | tail -n +50 | while read -r f; do rm -f -- "$f"; done
  if [ -f "$LOGF" ] && [ "$(wc -l < "$LOGF")" -gt 300 ]; then
    tail -n 200 "$LOGF" > "$LOGF.tmp" && mv -f "$LOGF.tmp" "$LOGF"
  fi
}

shutdown_all() {
  local id
  load_mountpoints
  load_active
  for id in "${!ATGT[@]}"; do do_umount "$id"; done
  save_active
  log "Package removed, helper unmounted everything and is exiting"
  rm -f "$PIDF" "$HBF" "$STATEF"
  exit 0
}

main_loop() {
  mkdir -p "$RUN"
  chmod 755 "$RUN"
  echo $$ > "$PIDF"
  trap 'rm -f "$PIDF"; exit 0' TERM INT
  log "Helper $HELPER_VERSION started"
  local tick=0 lastsum="" sum missing=0
  while true; do
    printf '%s %s\n' "$(date +%s)" "$HELPER_VERSION" > "$HBF.tmp" && mv -f "$HBF.tmp" "$HBF"
    chmod 644 "$HBF" 2>/dev/null
    if [ ! -d "$PKGDIR" ]; then
      missing=$((missing + 1))
      (( missing > 120 )) && shutdown_all
    else
      missing=0
      process_requests
      sum=$(cksum < "$CONF" 2>/dev/null)
      if [[ "$sum" != "$lastsum" ]] || (( tick % 10 == 0 )) || (( RETRY && tick % 3 == 0 )); then
        reconcile
        lastsum="$sum"
      fi
    fi
    tick=$((tick + 1))
    (( tick % 30 == 0 )) && cleanup_results
    sleep 1
  done
}

is_running() {
  local pid
  [ -f "$PIDF" ] || return 1
  pid=$(cat "$PIDF" 2>/dev/null)
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  grep -qa "bmm-helper" "/proc/$pid/cmdline" 2>/dev/null
}

case "$1" in
  start)
    [ "$(id -u)" = 0 ] || { echo "Run as root"; exit 1; }
    [ -d "$PKGDIR" ] || { echo "Bind Mount Manager is not installed"; exit 0; }
    if is_running; then echo "Helper already running"; exit 0; fi
    mkdir -p "$RUN"
    nohup setsid "$(readlink -f "$0")" run >/dev/null 2>&1 < /dev/null &
    echo "Helper started"
    ;;
  stop)
    if is_running; then kill "$(cat "$PIDF")"; echo "Helper stopped (mounts stay in place)"; else echo "Helper not running"; fi
    ;;
  restart)
    "$0" stop
    sleep 1
    "$0" start
    ;;
  status)
    if is_running; then echo "running (version $HELPER_VERSION)"; else echo "not running"; exit 1; fi
    ;;
  run)
    [ "$(id -u)" = 0 ] || exit 1
    main_loop
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac
