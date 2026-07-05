# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in `@krovacloud/sdk` or the Krova Cloud API, please report it **privately**. Do **not** open a public GitHub issue.

Email **security@krova.cloud** with:

- A description of the issue and its potential impact.
- Steps to reproduce (a minimal proof-of-concept is ideal).
- Affected version(s) of `@krovacloud/sdk`.

You will receive an acknowledgement as soon as possible, and we will keep you informed as we investigate and remediate. Please give us a reasonable window to address the issue before any public disclosure.

## Supported versions

As a pre-1.0 package, security fixes are applied to the latest `0.x` release. Once `1.0` ships, this policy will be updated with a support matrix.

## Handling API keys

Krova Cloud API keys (`kro_...`) grant access scoped to a Space. Treat them as secrets:

- Never commit keys to source control or embed them in client-side/browser bundles.
- Load keys from environment variables or a secrets manager.
- Rotate a key immediately if you suspect it has been exposed.
