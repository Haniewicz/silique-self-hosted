# Silique Server

Self-hosted synchronization server for Silique: end-to-end encrypted notes, syncable
across multiple devices. Node.js + TypeScript + Fastify + SQLite. The server stores
encrypted documents and key envelopes; search and merge run on the client. See
`Haniewicz/silique-app` for the client.

This is a **single-user** server: it serves exactly one account, usable from many
devices. Registration is first-user-wins — the first account is created, and any
further registration attempt is rejected with `403`.

## Requirements

- Node.js >= 24
- npm

## Quick start

```sh
npm ci
npm run build
npm start
```

The API listens on `127.0.0.1:8787` by default. The single account is normally
created from the Silique app on first launch (the app also sets up the account
key envelope and recovery key). For CI/throwaway bootstrapping only, you can
seed the account row from the CLI — the password is passed through the
environment, never as a command argument:

```sh
SILIQUE_INITIAL_PASSWORD='at-least-12-characters' npm run admin -- create-user user@example.com
```

> **Note:** `admin create-user` creates the account **without** an account key
> envelope (`accountEnvelope: null`), so the account has no Account Master Key
> envelope and no recovery key. Prefer account creation from the app; see the
> [self-hosting guide](docs/self-hosting.md) for details.

Configuration is read from environment variables: `HOST`, `PORT`, `DATABASE_PATH`,
`CORS_ORIGINS`.

- [Protocol v1](docs/protocol.md)
- [Encryption and threat model](docs/security.md)
- [Self-hosting guide](docs/self-hosting.md)

## License

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). Use is permitted
for personal, research, educational, and charitable purposes. **Commercial use requires
a separate license from the owner.** The software is provided without warranty.
