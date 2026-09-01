/**
 * ESLint config for the @krovacloud/n8n-nodes-krova community node package.
 *
 * Uses the official community-node linter, eslint-plugin-n8n-nodes-base, which
 * enforces the rules the n8n marketplace requires for community nodes.
 *
 * ⛔ FlatCompat is not optional here. The plugin ships ESLINTRC-STYLE configs
 * (`plugin:n8n-nodes-base/community` etc.) and has no flat export — its
 * `peerDependencies` say `eslint >=8.40`, but the shipped configs predate flat
 * config entirely. `FlatCompat` translates them; without it ESLint loads a
 * config with ZERO n8n rules and exits 0, which looks exactly like passing.
 * If you touch this file, re-run the "does it still catch anything" check in
 * the PR that introduced it before believing a green run.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
	baseDirectory: path.dirname(fileURLToPath(import.meta.url)),
});

export default [
	{
		ignores: [
			"**/*.js",
			"**/*.mjs",
			"**/node_modules/**",
			"**/dist/**",
			"scripts/**",
			"test/**",
		],
	},
	...compat.config({
		overrides: [
			{
				files: ["package.json"],
				parser: "jsonc-eslint-parser",
				plugins: ["eslint-plugin-n8n-nodes-base"],
				extends: ["plugin:n8n-nodes-base/community"],
			},
			{
				files: ["./credentials/**/*.ts"],
				parser: "@typescript-eslint/parser",
				parserOptions: { project: ["./tsconfig.json"], sourceType: "module" },
				plugins: ["eslint-plugin-n8n-nodes-base"],
				extends: ["plugin:n8n-nodes-base/credentials"],
				rules: {
					// This rule targets n8n's own monorepo, where `documentationUrl` is a
					// docs-site slug rather than a URL. For a community node a real
					// https:// documentation URL is correct, so the camelCase check does
					// not apply. The `-missing` and `-not-http-url` rules stay enforced.
					"n8n-nodes-base/cred-class-field-documentation-url-miscased": "off",
				},
			},
			{
				files: ["./nodes/**/*.ts"],
				parser: "@typescript-eslint/parser",
				parserOptions: { project: ["./tsconfig.json"], sourceType: "module" },
				plugins: ["eslint-plugin-n8n-nodes-base"],
				extends: ["plugin:n8n-nodes-base/nodes"],
			},
		],
	}),
];
