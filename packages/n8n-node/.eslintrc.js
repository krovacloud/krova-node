/**
 * ESLint config for the n8n-nodes-krova community node package.
 *
 * Uses the official community-node linter, eslint-plugin-n8n-nodes-base, which
 * enforces the rules the n8n marketplace requires for community nodes.
 */
module.exports = {
	root: true,
	env: {
		browser: true,
		es6: true,
		node: true,
	},
	ignorePatterns: [
		'.eslintrc.js',
		'**/*.js',
		'**/*.mjs',
		'**/node_modules/**',
		'**/dist/**',
		'scripts/**',
		'test/**',
	],
	overrides: [
		{
			files: ['package.json'],
			parser: 'jsonc-eslint-parser',
			plugins: ['eslint-plugin-n8n-nodes-base'],
			extends: ['plugin:n8n-nodes-base/community'],
		},
		{
			files: ['./credentials/**/*.ts'],
			parser: '@typescript-eslint/parser',
			parserOptions: {
				project: ['./tsconfig.json'],
				sourceType: 'module',
			},
			plugins: ['eslint-plugin-n8n-nodes-base'],
			extends: ['plugin:n8n-nodes-base/credentials'],
			rules: {
				// This rule targets n8n's own monorepo, where `documentationUrl` is a
				// docs-site slug rather than a URL. For a community node a real
				// https:// documentation URL is correct, so the camelCase check does
				// not apply. The `-missing` and `-not-http-url` rules stay enforced.
				'n8n-nodes-base/cred-class-field-documentation-url-miscased': 'off',
			},
		},
		{
			files: ['./nodes/**/*.ts'],
			parser: '@typescript-eslint/parser',
			parserOptions: {
				project: ['./tsconfig.json'],
				sourceType: 'module',
			},
			plugins: ['eslint-plugin-n8n-nodes-base'],
			extends: ['plugin:n8n-nodes-base/nodes'],
		},
	],
};
