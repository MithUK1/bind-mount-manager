#!/bin/bash
# Bind Mount Manager - web API
# Runs as the package user behind DSM's web server. It never mounts anything
# itself: it edits the mount list and talks to the root helper through files.

PKG="BindMountManager"
VAR="/var/packages/$PKG/var"
CONF="$VAR/mounts.conf"
SPOOL="$VAR/spool"
LOCKD="$VAR/.lock"
RUN="/run/bindmountmanager"
APP_VERSION="1.0.0"
EXPECTED_HELPER="1.0.0"
MAX_MOUNTS=100

umask 027
set -f
export PATH=/usr/syno/sbin:/usr/syno/bin:/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

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

reply() {
  printf 'Status: %s\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\r\n%s\n' "$1" "$2"
  exit 0
}
ok() { reply "200 OK" "$1"; }
err() { reply "${2:-400 Bad Request}" "{\"ok\":false,\"error\":\"$(jesc "$1")\"}"; }

urldecode() {
  local s="${1//+/ }"
  s="${s//\\/%5C}"
  printf '%b' "${s//%/\\x}"
}

declare -A P
parse_kv() {
  local s="$1" kv k v
  local IFS='&'
  for kv in $s; do
    k="${kv%%=*}"
    v=""
    [[ "$kv" == *=* ]] && v="${kv#*=}"
    k=$(urldecode "$k")
    [[ "$k" =~ ^[a-zA-Z]{1,16}$ ]] || continue
    P[$k]=$(urldecode "$v")
  done
}

# ---------- Sign-in check (DSM session) ----------
AUTH_USER=$(/usr/syno/synoman/webman/modules/authenticate.cgi 2>/dev/null | head -n 1)
[[ -n "$AUTH_USER" ]] || err "You are not signed in to DSM" "401 Unauthorized"
if ! id -Gn -- "$AUTH_USER" 2>/dev/null | tr ' ' '\n' | grep -qx administrators; then
  err "An administrator account is required" "403 Forbidden"
fi

# ---------- Read the request ----------
parse_kv "$QUERY_STRING"
if [[ "$REQUEST_METHOD" == "POST" ]]; then
  [[ "$HTTP_X_REQUESTED_WITH" == "bmm" ]] || err "Missing request header" "403 Forbidden"
  len="${CONTENT_LENGTH:-0}"
  [[ "$len" =~ ^[0-9]+$ ]] && (( len > 0 && len <= 8192 )) || err "Bad request"
  IFS= read -r -N "$len" BODY
  parse_kv "$BODY"
fi
ACTION="${P[action]}"

# ---------- Helpers ----------
HELPER_ALIVE=false
HELPER_VER=""
HELPER_AGE=-1
check_helper() {
  local ts="" hv="" now
  now=$(date +%s)
  if [ -r "$RUN/heartbeat" ]; then
    read -r ts hv < "$RUN/heartbeat"
    if [[ "$ts" =~ ^[0-9]+$ ]]; then
      HELPER_AGE=$(( now - ts ))
      HELPER_VER="$hv"
      (( HELPER_AGE <= 10 )) && HELPER_ALIVE=true
    fi
  fi
}

lock() {
  local i=0
  mkdir -p "$VAR" 2>/dev/null
  until mkdir "$LOCKD" 2>/dev/null; do
    i=$((i + 1))
    (( i > 50 )) && rmdir "$LOCKD" 2>/dev/null
    sleep 0.1 2>/dev/null || sleep 1
  done
  trap 'rmdir "$LOCKD" 2>/dev/null' EXIT
}
unlock() { rmdir "$LOCKD" 2>/dev/null; trap - EXIT; }

# Syntax check only. The root helper does the real checks on the real folders.
check_path() {
  local p="$1"
  [[ "$p" =~ ^/volume[A-Za-z0-9]+(/[^/]+)+$ ]] || return 1
  [[ "$p" =~ [[:cntrl:]] ]] && return 1
  [[ "$p" == *\\* ]] && return 1
  case "/$p/" in
    */../*|*/./*|*/@*|*/\#*) return 1 ;;
  esac
  return 0
}
depth_of() {
  local t="${1//[^\/]/}"
  echo $(( ${#t} - 1 ))
}

spool_call() {
  # $1 cmd, $2 path, $3 name. Prints the helper's JSON reply.
  local rid start
  check_helper
  [[ "$HELPER_ALIVE" == true ]] || return 2
  mkdir -p "$SPOOL" 2>/dev/null
  rid="$(date +%s)${RANDOM}${RANDOM}"
  printf 'cmd=%s\npath=%s\nname=%s\n' "$1" "$2" "$3" > "$SPOOL/.req.$rid.tmp" || return 1
  mv -f "$SPOOL/.req.$rid.tmp" "$SPOOL/req.$rid" || return 1
  start=$SECONDS
  while (( SECONDS - start < 8 )); do
    if [ -f "$RUN/res.$rid" ]; then cat "$RUN/res.$rid"; return 0; fi
    sleep 0.25 2>/dev/null || sleep 1
  done
  rm -f "$SPOOL/req.$rid"
  return 3
}

# ---------- Actions ----------
action_status() {
  local id en ro src tgt state msg list="" sep="" ts
  declare -A ST MSG
  check_helper
  if [[ "$HELPER_ALIVE" == true && -r "$RUN/state.tsv" ]]; then
    while IFS=$'\t' read -r id state msg || [ -n "$id" ]; do
      [[ "$id" =~ ^m[0-9]+$ ]] || continue
      ST[$id]="$state"
      MSG[$id]="$msg"
    done < "$RUN/state.tsv"
  fi
  if [ -f "$CONF" ]; then
    while IFS=$'\t' read -r id en ro src tgt || [ -n "$id" ]; do
      [[ "$id" =~ ^m[0-9]+$ ]] || continue
      state="${ST[$id]}"
      msg="${MSG[$id]}"
      if [[ -z "$state" ]]; then
        if [[ "$HELPER_ALIVE" == true ]]; then state="pending"; msg="Applying"; else state="unknown"; msg="Waiting for the helper"; fi
      fi
      list+="$sep{\"id\":\"$id\",\"enabled\":$([[ "$en" == 1 ]] && echo true || echo false),\"ro\":$([[ "$ro" == 1 ]] && echo true || echo false),\"source\":\"$(jesc "$src")\",\"target\":\"$(jesc "$tgt")\",\"state\":\"$(jesc "$state")\",\"message\":\"$(jesc "$msg")\"}"
      sep=","
    done < "$CONF"
  fi
  ok "{\"ok\":true,\"user\":\"$(jesc "$AUTH_USER")\",\"host\":\"$(jesc "$(hostname 2>/dev/null | tr a-z A-Z)")\",\"version\":\"$APP_VERSION\",\"helper\":{\"alive\":$HELPER_ALIVE,\"version\":\"$(jesc "$HELPER_VER")\",\"expected\":\"$EXPECTED_HELPER\",\"age\":$HELPER_AGE},\"mounts\":[$list]}"
}

action_browse() {
  local p="${P[path]%/}" out rc
  if [[ -n "$p" ]] && ! check_path "$p" && ! [[ "$p" =~ ^/volume[A-Za-z0-9]+$ ]]; then err "That path is not allowed"; fi
  out=$(spool_call browse "$p" ""); rc=$?
  case $rc in
    0) ok "$out" ;;
    2) err "The helper is not running yet" "503 Service Unavailable" ;;
    *) err "The helper did not answer in time" "504 Gateway Timeout" ;;
  esac
}

action_mkdir() {
  local p="${P[path]%/}" name="${P[name]}" out rc
  check_path "$p" || err "That path is not allowed"
  [[ -n "$name" && ${#name} -le 100 && "$name" != */* && "$name" != "." && "$name" != ".." ]] || err "That folder name is not allowed"
  [[ "$name" =~ [[:cntrl:]] ]] && err "That folder name is not allowed"
  out=$(spool_call mkdir "$p" "$name"); rc=$?
  case $rc in
    0) ok "$out" ;;
    2) err "The helper is not running yet" "503 Service Unavailable" ;;
    *) err "The helper did not answer in time" "504 Gateway Timeout" ;;
  esac
}

action_add() {
  local src="${P[source]%/}" tgt="${P[target]%/}" ro="${P[ro]}" id n=0 line
  [[ "$ro" == 1 ]] || ro=0
  check_path "$src" || err "The source folder path is not valid"
  check_path "$tgt" || err "The target folder path is not valid"
  (( $(depth_of "$src") >= 1 )) || err "The source must be a folder on a volume"
  (( $(depth_of "$tgt") >= 1 )) || err "The target must be a shared folder or a folder inside one"
  [[ "$src" != "$tgt" ]] || err "Source and target cannot be the same folder"
  [[ "$tgt/" != "$src/"* ]] || err "The target cannot be inside the source folder"
  [[ "$src/" != "$tgt/"* ]] || err "The source cannot be inside the target folder"
  lock
  if [ -f "$CONF" ]; then
    while IFS=$'\t' read -r id _ _ _ line || [ -n "$id" ]; do
      n=$((n + 1))
      [[ "$line" == "$tgt" ]] && { unlock; err "That target folder already has a mount"; }
    done < "$CONF"
  fi
  (( n < MAX_MOUNTS )) || { unlock; err "You reached the limit of $MAX_MOUNTS mounts"; }
  id="m$(date +%s)$RANDOM"
  printf '%s\t1\t%s\t%s\t%s\n' "$id" "$ro" "$src" "$tgt" >> "$CONF" || { unlock; err "Could not save the mount list" "500 Internal Server Error"; }
  unlock
  ok "{\"ok\":true,\"id\":\"$id\"}"
}

action_remove() {
  local id="${P[id]}"
  [[ "$id" =~ ^m[0-9]+$ ]] || err "Bad id"
  lock
  [ -f "$CONF" ] || { unlock; ok '{"ok":true}'; }
  awk -F'\t' -v id="$id" '$1 != id' "$CONF" > "$CONF.tmp" && mv -f "$CONF.tmp" "$CONF" || { unlock; err "Could not save the mount list" "500 Internal Server Error"; }
  unlock
  ok '{"ok":true}'
}

action_toggle() {
  local id="${P[id]}" en="${P[enabled]}"
  [[ "$id" =~ ^m[0-9]+$ ]] || err "Bad id"
  [[ "$en" == 0 || "$en" == 1 ]] || err "Bad value"
  lock
  [ -f "$CONF" ] || { unlock; err "Nothing to change"; }
  awk -F'\t' -v OFS='\t' -v id="$id" -v en="$en" '$1 == id { $2 = en } { print }' "$CONF" > "$CONF.tmp" && mv -f "$CONF.tmp" "$CONF" || { unlock; err "Could not save the mount list" "500 Internal Server Error"; }
  unlock
  ok '{"ok":true}'
}

case "$ACTION" in
  status) action_status ;;
  browse) action_browse ;;
  mkdir)  [[ "$REQUEST_METHOD" == "POST" ]] || err "POST required" "405 Method Not Allowed"; action_mkdir ;;
  add)    [[ "$REQUEST_METHOD" == "POST" ]] || err "POST required" "405 Method Not Allowed"; action_add ;;
  remove) [[ "$REQUEST_METHOD" == "POST" ]] || err "POST required" "405 Method Not Allowed"; action_remove ;;
  toggle) [[ "$REQUEST_METHOD" == "POST" ]] || err "POST required" "405 Method Not Allowed"; action_toggle ;;
  *)      err "Unknown action" ;;
esac
