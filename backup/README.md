# Backup da mídia (MinIO)

O bucket MinIO (`neura-media`) guarda os anexos das conversas (imagens, áudios,
docs). O serviço `minio-backup` (no `docker-compose.yaml`) faz `mc mirror` do
bucket pra um destino S3-compatível, periodicamente.

## Como ativar

1. Criar um bucket num provedor S3-compatível (Backblaze B2 é barato; AWS S3;
   outro MinIO; etc.) e gerar uma access key/secret com escrita nesse bucket.
2. Setar no ambiente (Coolify → env do projeto):
   ```
   BACKUP_S3_ENDPOINT=https://s3.us-west-002.backblazeb2.com
   BACKUP_S3_ACCESS_KEY=...
   BACKUP_S3_SECRET_KEY=...
   BACKUP_S3_BUCKET=neura-media-backup
   BACKUP_INTERVAL_SECONDS=86400   # opcional (default 24h)
   ```
3. Redeploy. O container `minio-backup` passa a espelhar a cada intervalo.

**Sem `BACKUP_S3_*`, o container fica idle** (loga "desativado" e dorme) — não
atrapalha o deploy.

## Comportamento

- `mc mirror --overwrite` (aditivo): copia arquivos novos/alterados. **Não usa
  `--remove`** — arquivos apagados na origem PERMANECEM no backup (proteção contra
  perda/exclusão acidental). Se quiser espelho exato, adicione `--remove` no
  `backup/backup.sh` (cuidado: apaga do backup).
- Roda num loop com `sleep BACKUP_INTERVAL_SECONDS`. Falha de um ciclo não derruba
  o container — tenta no próximo.

## Restaurar

Do destino pra um MinIO novo/limpo (mesmas aliases do script):
```sh
mc alias set dst  <BACKUP_S3_ENDPOINT> <ACCESS> <SECRET>
mc alias set src  http://minio:9000    <MINIO_ROOT_USER> <MINIO_ROOT_PASSWORD>
mc mirror --overwrite dst/<BACKUP_S3_BUCKET> src/neura-media
```

## Nota sobre a imagem
Usa `minio/mc` + `/bin/sh`. Se a tag do `mc` que você fixar não tiver shell,
troque por uma tag `RELEASE.*` que tenha, ou rode o mesmo script numa imagem
`alpine` com o binário `mc` instalado.

## Postgres
O backup do Postgres é separado (backup nativo do Coolify + `pg_dump`), não faz
parte deste serviço.
