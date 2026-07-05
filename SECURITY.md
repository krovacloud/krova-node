# Security Policy

This policy covers every package published from this repository:

- [`@krovacloud/sdk`](https://www.npmjs.com/package/@krovacloud/sdk)
- [`@krovacloud/cli`](https://www.npmjs.com/package/@krovacloud/cli)
- [`@krovacloud/mcp`](https://www.npmjs.com/package/@krovacloud/mcp)
- [`@krovacloud/webhook`](https://www.npmjs.com/package/@krovacloud/webhook)
- [`n8n-nodes-krova`](https://www.npmjs.com/package/n8n-nodes-krova)

## Supported versions

As pre-1.0 packages, security fixes are applied to the **latest published
version** of each package. Please upgrade to the latest before reporting. Once a
package reaches `1.0`, this policy will be updated with a support matrix.

## Reporting a vulnerability

If you discover a security vulnerability in any of these packages or the Krova
Cloud API, please report it **privately**. Do **not** open a public GitHub issue,
discussion, or pull request.

Preferred: use GitHub's [**private vulnerability reporting**](https://github.com/krovacloud/krova-node/security/advisories/new)
("Report a vulnerability" under the repository's Security tab).

Alternatively, email **security@krova.cloud** with:

- The affected package(s) and version(s).
- A description of the issue and its potential impact.
- Steps to reproduce (a minimal proof-of-concept is ideal).

You will receive an acknowledgement as soon as possible (we aim for **2 business
days**), and we will keep you informed as we investigate and remediate. Please
give us a reasonable window to address the issue before any public disclosure.
Once a fix is released, we're happy to credit you (if you'd like) in the release
notes and any advisory.

## Scope

In scope: the source and published artifacts of the packages listed above.

Out of scope: vulnerabilities in third-party dependencies (please report those
upstream, though we appreciate a heads-up), and issues in the Krova Cloud
platform itself unrelated to these libraries — for those, email
**security@krova.cloud**.

## Handling API keys and secrets

Krova Cloud API keys (`kro_...`) grant access scoped to a Space. Treat them as
secrets:

- Never commit keys to source control or embed them in client-side/browser
  bundles.
- Load keys from environment variables or a secrets manager.
- Rotate a key immediately if you suspect it has been exposed.

Never paste an API key, token, or `~/.config/krova/config.json` contents into an
issue, PR, or log attachment. If a secret was exposed, **revoke it first** and say
so in your report. The CLI stores its config with `0600` permissions and masks
keys in output — please do the same in anything you share.
