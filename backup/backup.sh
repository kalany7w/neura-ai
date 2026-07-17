#!/bin/sh
# Backup periódico do bucket MinIO (mídia dos clientes) pra um destino
# S3-compatível (Backblaze B2 / AWS S3 / outro MinIO). Usa `mc mirror`.
#
# NÃO usa --remove de propósito: é BACKUP (proteção contra perda), então arquivos
# apagados na origem PERMANECEM no destino. Mirror aditivo.
#
# Sem BACKUP_S3_* configurado, o container fica idle (não quebra o deploy).
set -eu

MINIO_ENDPOINT="${MINIO_ENDPOINT:-minio}"
MINIO_PORT="${MINIO_PORT:-9000}"
MINIO_BUCKET="${MINIO_BUCKET:-neura-media}"
BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"

if [ -z "${BACKUP_S3_ENDPOINT:-}" ] || [ -z "${BACKUP_S3_ACCESS_KEY:-}" ] \
  || [ -z "${BACKUP_S3_SECRET_KEY:-}" ] || [ -z "${BACKUP_S3_BUCKET:-}" ]; then
  echo "[minio-backup] desativado: faltam BACKUP_S3_* (endpoint/access/secret/bucket). Idle."
  exec sleep infinity
fi

echo "[minio-backup] configurando aliases mc…"
mc alias set src "http://${MINIO_ENDPOINT}:${MINIO_PORT}" "${MINIO_ACCESS_KEY}" "${MINIO_SECRET_KEY}"
mc alias set dst "${BACKUP_S3_ENDPOINT}" "${BACKUP_S3_ACCESS_KEY}" "${BACKUP_S3_SECRET_KEY}"

while true; do
  echo "[minio-backup] $(date -u '+%Y-%m-%dT%H:%M:%SZ') mirror ${MINIO_BUCKET} -> ${BACKUP_S3_BUCKET}"
  if mc mirror --overwrite "src/${MINIO_BUCKET}" "dst/${BACKUP_S3_BUCKET}"; then
    echo "[minio-backup] ok"
  else
    echo "[minio-backup] mirror falhou — tenta no próximo ciclo"
  fi
  sleep "${BACKUP_INTERVAL_SECONDS}"
done
