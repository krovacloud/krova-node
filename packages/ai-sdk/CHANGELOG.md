# Changelog

All notable changes to `@krovacloud/ai-sdk` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## 0.1.1

### Fixed

- 0.1.1: depends on `@krovacloud/sdk` with the `./ssh` entry; 0.1.0 pinned an sdk without it, so `import "@krovacloud/sdk/ssh"` failed on install. Use 0.1.1 or later.

## 0.1.0

### Added

- First release: Vercel AI SDK tools that let an agent run commands and read and write files in a Krova Cube over SSH.
