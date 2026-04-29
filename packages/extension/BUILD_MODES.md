# Extension Build Modes

The repository keeps one extension codebase and produces separate distributions.

## Admin Local

Use this build only for local enrichment work: import, capture, debug, and data writes.

```bash
npm run build:admin --workspace @vpauto/extension
```

Load this folder in Chrome developer mode:

```text
packages/extension/.output-admin/chrome-mv3
```

For a hosted backend, configure admin credentials server-side:

```bash
VPAUTO_ADMIN_EMAIL=you@example.com
VPAUTO_ADMIN_PASSWORD=change-me
VPAUTO_ADMIN_TOKEN=long-random-token
VPAUTO_AUTH_SECRET=another-long-random-secret
```

The extension login form stores only the returned session token locally.

## User Local Test

Use this to test the public user experience against the local backend.

```bash
npm run build:user:local --workspace @vpauto/extension
```

Load this folder in Chrome developer mode:

```text
packages/extension/.output-user-local/chrome-mv3
```

## User Chrome Store

Set the hosted API URL explicitly. The build fails when the URL is missing so
the public extension is not accidentally built against localhost.

```bash
VITE_VPAUTO_API_URL=https://api.your-domain.com npm run build:user --workspace @vpauto/extension
```

The generated folder is:

```text
packages/extension/.output-user/chrome-mv3
```

To create the store artifact:

```bash
VITE_VPAUTO_API_URL=https://api.your-domain.com npm run zip:user --workspace @vpauto/extension
```

Optional future roles can be configured on the backend with `VPAUTO_AUTH_USERS`:

```json
[
  { "email": "analyst@example.com", "password": "change-me", "role": "analyst" },
  { "email": "viewer@example.com", "password": "change-me", "role": "viewer" }
]
```

On a hosted backend, always set `VPAUTO_AUTH_SECRET` with a long random value.
