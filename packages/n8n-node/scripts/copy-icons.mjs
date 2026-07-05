// Copies node/credential icon assets (svg/png) into dist/, preserving the
// same relative path tsc used for the compiled .js — n8n resolves
// `icon: 'file:krova.svg'` relative to the compiled node file.
import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const iconExtensions = new Set(['.svg', '.png']);

async function* walk(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walk(full);
		} else if (iconExtensions.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
			yield full;
		}
	}
}

let count = 0;
for (const sourceDir of ['nodes', 'credentials']) {
	const abs = join(root, sourceDir);
	try {
		for await (const file of walk(abs)) {
			const dest = join(root, 'dist', relative(root, file));
			await mkdir(dirname(dest), { recursive: true });
			await cp(file, dest);
			count += 1;
			console.log(`copied icon: ${relative(root, file)} -> ${relative(root, dest)}`);
		}
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
}

console.log(`copy-icons: ${count} icon(s) copied.`);
