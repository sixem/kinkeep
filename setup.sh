#!/usr/bin/env bash
# Manage only KinKeep's Docker Compose project. Archive data is never removed.
set -euo pipefail

project_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cd "$project_dir"
project_name=kinkeep-local
env_file="$project_dir/.env"

usage() {
  cat <<'USAGE'
KinKeep local archive

Usage: ./setup.sh [command]
  start       Set up and start the archive (builds its image)
  status      Show project containers and health
  stop        Stop the archive, keeping its data
  restart     Restart the archive
  update      Rebuild and start with the current project files
  reinstall   Rebuild and recreate the app container, keeping its data
  logs        Follow archive server logs
  help        Show this help

Run without a command for the interactive menu.
USAGE
}

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    printf '%s\n' 'Docker was not found. Install Docker and Docker Compose, then try again.' >&2
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    printf '%s\n' 'Docker Compose v2 is required (docker compose).' >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    printf '%s\n' 'Cannot reach the Docker daemon. Start Docker and try again.' >&2
    exit 1
  fi
}

# Refuse to manage an unrelated project if its Compose project name collides.
check_project_ownership() {
  local ids id managed
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=$project_name")
  for id in $ids; do
    managed=$(docker inspect --format '{{ index .Config.Labels "io.kinkeep.managed" }}' "$id")
    if [[ "$managed" != true ]]; then
      printf '%s\n' "A container in Compose project '$project_name' is not marked as KinKeep-managed. Refusing to change it." >&2
      exit 1
    fi
  done
}

ensure_env() {
  if [[ ! -e "$env_file" ]]; then
    if ! command -v openssl >/dev/null 2>&1; then
      printf '%s\n' 'OpenSSL is needed to generate a secure archive token. Install it and try again.' >&2
      exit 1
    fi
    local token
    token=$(openssl rand -hex 32)
    # noclobber ensures an existing configuration is never overwritten, even in a race.
    if ! (umask 077; set -o noclobber; printf 'KINKEEP_TOKEN=%s\n' "$token" > "$env_file") 2>/dev/null; then
      printf '%s\n' "Could not create $env_file; check its permissions or use the existing file." >&2
      exit 1
    fi
    printf 'Created archive credentials in %s\n' "$env_file"
  fi
  if ! grep -Eq '^KINKEEP_TOKEN=.+$' "$env_file"; then
    printf '%s\n' "Set a nonempty KINKEEP_TOKEN in $env_file before continuing." >&2
    exit 1
  fi
}

compose() {
  # Compose otherwise gives an inherited shell variable precedence over .env.
  (unset KINKEEP_TOKEN; docker compose --project-name "$project_name" --env-file "$env_file" -f "$project_dir/docker-compose.yml" "$@")
}

show_status() {
  printf '%s\n' 'KinKeep containers:'
  docker ps -a --filter "label=com.docker.compose.project=$project_name" \
    --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
  printf '\n%s\n' 'Archive URL: http://127.0.0.1:8765'
}

run_action() {
  local action=$1
  case "$action" in help|-h|--help) usage; return ;; esac
  case "$action" in
    start|status|stop|restart|update|reinstall|logs) ;;
    *) printf 'Unknown command: %s\n\n' "$action" >&2; usage >&2; return 2 ;;
  esac
  check_docker
  check_project_ownership
  if [[ "$action" == status ]]; then show_status; return; fi
  if [[ "$action" == stop || "$action" == logs ]]; then
    if [[ ! -f "$env_file" ]]; then
      printf '%s\n' "Configuration $env_file is missing; no changes made." >&2
      return 1
    fi
  else
    ensure_env
  fi
  case "$action" in
    start) compose up -d --build ;;
    stop) compose stop ;;
    restart) compose up -d; compose restart ;;
    update) compose up -d --build ;;
    reinstall) compose up -d --build --force-recreate ;;
    logs) compose logs -f ;;
  esac
  if [[ "$action" != logs && "$action" != stop ]]; then
    printf '\nArchive: http://127.0.0.1:8765\nCredentials: %s\n' "$env_file"
    printf '%s\n' 'Copy the KINKEEP_TOKEN value into the extension settings. Keep it private.'
  fi
}

if [[ $# -gt 1 ]]; then usage >&2; exit 2; fi
if [[ $# -eq 1 ]]; then run_action "$1"; exit; fi
if [[ ! -t 0 ]]; then usage; exit 0; fi

run_action status
while true; do
  printf '\n%s\n' 'KinKeep archive' '1) Start / set up' '2) Status' '3) Stop' '4) Restart' '5) Update' '6) Reinstall (preserves data)' '7) View logs' '0) Exit'
  read -r -p 'Choose an option: ' choice || break
  case "$choice" in
    1) run_action start ;;
    2) run_action status ;;
    3) run_action stop ;;
    4) run_action restart ;;
    5) run_action update ;;
    6) run_action reinstall ;;
    7) run_action logs ;;
    0|q|Q) break ;;
    *) printf '%s\n' 'Choose a listed option.' ;;
  esac
done
