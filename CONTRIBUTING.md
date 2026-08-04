# Contributing

Thanks for your interest! This project is maintained by a small team — pragmatic PRs beat perfect ones.

## Dev setup

See [README → Local development](README.md#local-development). TL;DR: pnpm 11, Docker for Postgres/Redis/MinIO, `pnpm dev`.

## Before opening a PR

1. `pnpm build` passes (turbo builds api + web + waworker)
2. `pnpm test` passes — new behavior comes with a test
3. `pnpm lint` clean
4. Keep the diff scoped: one topic per PR

## Conventions

- TypeScript strict; Zod at every boundary (env, HTTP payloads, queue jobs)
- Every DB write: `await` + `try/catch` + user-visible error state (toast in the UI)
- Every new table/listing in the UI ships paginated (10/25/50/100, default 25)
- Migrations via `pnpm db:migrate:dev` — never edit applied migrations
- No new host-exposed ports in `docker-compose.selfhost.yml` without discussion

## Reporting bugs / security

- Bugs: open an issue with repro steps and logs (`docker compose logs api waworker`)
- Security vulnerabilities: **do not open a public issue** — email the maintainer instead

## License

By contributing you agree your contributions are licensed under [AGPL-3.0](LICENSE).
