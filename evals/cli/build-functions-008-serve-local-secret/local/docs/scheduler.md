# Nightly digest scheduler

The scheduler triggers our nightly digest by calling an endpoint on this project. This note describes the contract it expects.

## Request

Once a night the scheduler sends:

```
POST <project API URL>/functions/v1/nightly-digest
x-digest-secret: <DIGEST_SECRET>
content-type: application/json

{"run":"nightly"}
```

`<DIGEST_SECRET>` is the secret we share with the scheduler. It comes from the project's environment.

## Response

- When the `x-digest-secret` header matches the shared secret, the endpoint answers with a 2xx. For now the body is just `{"queued": true}`; the actual digest work comes later.
- When the header is missing or wrong, the endpoint answers `401`. It never echoes the expected value back, in the body or anywhere else.

## Handling the secret

The secret is never written into code or committed files. Rotating it should only mean changing the value in the project's environment.
