#!/usr/bin/env bash
# Exercise the actual Compose service with disposable synthetic data, no host ports,
# and an isolated project/volume. Never reads or modifies the normal .env or volume.
set -euo pipefail

project_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
check_project="kinexport-smoke-$(date +%s)-$$-$RANDOM"
check_volume="${check_project}_archive-data"
check_network="${check_project}_default"
check_image="${check_project}-archive"
check_token=disposable-test-token-012345678901234567890123456789

if ! docker compose version >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  printf '%s\n' 'Docker and Docker Compose v2 must be available.' >&2
  exit 1
fi
# Refuse even an exceptionally unlikely name collision before creating anything.
if [[ -n $(docker ps -aq --filter "label=com.docker.compose.project=$check_project") ]] ||
   docker volume inspect "$check_volume" >/dev/null 2>&1 ||
   docker network inspect "$check_network" >/dev/null 2>&1 ||
   docker image inspect "$check_image" >/dev/null 2>&1; then
  printf '%s\n' 'A resource with the temporary test name already exists; no changes made.' >&2
  exit 1
fi
check_tmp=$(mktemp -d "${TMPDIR:-/tmp}/kinexport-smoke.XXXXXXXX")
cleanup() {
  local ids
  # Only this freshly created, labeled project and its exact resources are removed.
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=$check_project" --filter 'label=io.kinexport.managed=true' 2>/dev/null) || ids=''
  if [[ -n "$ids" ]]; then docker rm -f $ids >/dev/null 2>&1 || :; fi
  docker volume rm "$check_volume" >/dev/null 2>&1 || :
  docker network rm "$check_network" >/dev/null 2>&1 || :
  docker image rm "$check_image" >/dev/null 2>&1 || :
  rm -rf -- "$check_tmp"
}
trap cleanup EXIT
printf 'KINEXPORT_TOKEN=%s\n' "$check_token" > "$check_tmp/.env"
compose() {
  (unset KINEXPORT_TOKEN; docker compose --project-name "$check_project" --env-file "$check_tmp/.env" -f "$project_dir/docker-compose.yml" "$@")
}

compose build --quiet archive >/dev/null
# Compose run does not publish service ports unless --service-ports is supplied.
container_id=$(compose run --no-deps --no-TTY -d archive)
for attempt in $(seq 1 20); do
  if docker exec "$container_id" node -e "fetch('http://127.0.0.1:8765/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then break; fi
  if [[ "$attempt" == 20 ]]; then
    printf '%s\n' 'Test archive failed to become healthy.' >&2
    docker logs "$container_id" >&2
    exit 1
  fi
  sleep 1
done

docker exec -i "$container_id" node --input-type=module <<'JS'
import { spawnSync } from 'node:child_process';
import { createThumbnail } from './thumbnail.js';

const image = spawnSync('magick', ['-size', '8x8', 'xc:red', 'png:-']);
if (image.status !== 0 || !(await createThumbnail(image.stdout)).length) throw new Error('Thumbnail generation failed');
const auth = { Authorization: 'Bearer disposable-test-token-012345678901234567890123456789' };
async function call(path, options = {}) {
  let response;
  // Transfer cleanup can finish just after the preceding response is received.
  for (let attempt = 0; attempt < 20; attempt++) {
    response = await fetch(`http://127.0.0.1:8765${path}`, { ...options, headers: { ...auth, ...options.headers } });
    if (response.status !== 409) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response;
}
await call('/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: 'example' }) });
await call('/api/kins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: 'example', kinId: 'example', name: 'Example' }) });
const zip = new Uint8Array(await (await call('/api/download/portable')).arrayBuffer());
if (zip.length < 100 || zip[0] !== 0x50 || zip[1] !== 0x4b) throw new Error('Invalid ZIP export');
await call('/api/import/portable', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zip });
const backup = new Uint8Array(await (await call('/api/download/sqlite')).arrayBuffer());
if (new TextDecoder().decode(backup.slice(0, 15)) !== 'SQLite format 3') throw new Error('Invalid SQLite backup');
await call('/api/restore/sqlite', { method: 'POST', headers: { 'Content-Type': 'application/vnd.sqlite3' }, body: backup });
const data = await (await call('/api/kins?accountId=example')).json();
if (data.kins.length !== 1) throw new Error('Restored archive is missing the example Kin');
console.log('Passed: health, thumbnail generation, archive writes, ZIP export/import, and SQLite backup/restore.');
JS
