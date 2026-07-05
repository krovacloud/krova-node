import assert from 'node:assert/strict';
import { test } from 'node:test';

// Import the COMPILED output — this is what n8n actually loads at runtime.
const { Krova } = await import('../dist/nodes/Krova/Krova.node.js');
const { KrovaApi } = await import('../dist/credentials/KrovaApi.credentials.js');

const node = new Krova();
const desc = node.description;

function operationsForResource(resource) {
	// Each resource has its own `operation` property block, shown via displayOptions.
	const blocks = desc.properties.filter(
		(p) =>
			p.name === 'operation' &&
			p.displayOptions?.show?.resource?.includes(resource),
	);
	return blocks.flatMap((b) => b.options.map((o) => o.value));
}

test('node description is well-formed', () => {
	assert.equal(desc.name, 'krova');
	assert.equal(desc.displayName, 'Krova Cloud');
	assert.equal(desc.version, 1);
	assert.ok(desc.description.length > 0, 'has a description string');
	assert.equal(desc.icon, 'file:krova.svg');
	assert.deepEqual(desc.defaults, { name: 'Krova Cloud' });
	assert.ok(Array.isArray(desc.inputs) && desc.inputs.length === 1);
	assert.ok(Array.isArray(desc.outputs) && desc.outputs.length === 1);
});

test('node requires the krovaApi credential', () => {
	const cred = desc.credentials.find((c) => c.name === 'krovaApi');
	assert.ok(cred, 'krovaApi credential is declared');
	assert.equal(cred.required, true);
});

test('requestDefaults use the credential base URL', () => {
	assert.equal(desc.requestDefaults.baseURL, '={{ $credentials.baseUrl }}');
});

test('exposes Cube and Catalog resources', () => {
	const resourceProp = desc.properties.find((p) => p.name === 'resource');
	assert.ok(resourceProp, 'resource selector exists');
	const values = resourceProp.options.map((o) => o.value);
	assert.deepEqual(values.sort(), ['catalog', 'cube']);
});

test('Cube resource has the expected operations', () => {
	const ops = operationsForResource('cube').sort();
	assert.deepEqual(ops, ['create', 'delete', 'get', 'list', 'sleep', 'wake']);
});

test('Catalog resource has the expected operations', () => {
	const ops = operationsForResource('catalog').sort();
	assert.deepEqual(ops, ['getImages', 'getPricing', 'getRegions']);
});

test('Cube Create maps name/image/region/vcpu/ramGb/diskGb to the request body', () => {
	const props = desc.properties.filter((p) =>
		p.displayOptions?.show?.operation?.includes('create'),
	);
	const byName = Object.fromEntries(props.map((p) => [p.name, p]));

	assert.equal(byName.name.routing.send.property, 'name');
	assert.equal(byName.image.routing.send.property, 'image');
	assert.equal(byName.sshPublicKey.routing.send.property, 'sshPublicKey');
	assert.equal(byName.vcpu.routing.send.property, 'resources.vcpu');
	assert.equal(byName.ramGb.routing.send.property, 'resources.ramGb');
	assert.equal(byName.diskGb.routing.send.property, 'resources.diskGb');

	// region is an optional (Additional Fields) property
	const region = byName.additionalFields.options.find((o) => o.name === 'region');
	assert.equal(region.routing.send.property, 'region');
});

test('Cube operations route to the correct space-scoped endpoints', () => {
	const opProp = desc.properties.find(
		(p) => p.name === 'operation' && p.displayOptions?.show?.resource?.includes('cube'),
	);
	const routes = Object.fromEntries(
		opProp.options.map((o) => [o.value, o.routing.request]),
	);
	assert.equal(routes.list.method, 'GET');
	assert.match(routes.list.url, /\/spaces\/.*\/cubes$/);
	assert.equal(routes.create.method, 'POST');
	assert.equal(routes.delete.method, 'DELETE');
	assert.equal(routes.sleep.method, 'POST');
	assert.match(routes.sleep.url, /\/sleep$/);
	assert.equal(routes.wake.method, 'POST');
	assert.match(routes.wake.url, /\/wake$/);
});

test('path params (spaceId/cubeId) are URL-encoded to prevent path-segment injection', () => {
	// A spaceId/cubeId containing `?`, `#`, `/`, or spaces must not be able to
	// alter the request path/query. n8n interpolates routing URLs unencoded, so
	// every ID interpolation MUST be wrapped in encodeURIComponent(). Without it,
	// e.g. spaceId="x?evil=1" would inject a query string and swallow the intended
	// `/cubes` suffix (same host — the X-API-KEY host stays pinned — but the wrong
	// endpoint is hit).
	const opProp = desc.properties.find(
		(p) => p.name === 'operation' && p.displayOptions?.show?.resource?.includes('cube'),
	);
	for (const option of opProp.options) {
		const url = option.routing.request.url;
		if (url.includes('spaceId')) {
			assert.match(
				url,
				/encodeURIComponent\(\$parameter\["spaceId"\]\)/,
				`operation "${option.value}" must encode spaceId, got: ${url}`,
			);
			assert.doesNotMatch(
				url,
				/\{\{ \$parameter\["spaceId"\] \}\}/,
				`operation "${option.value}" must NOT interpolate spaceId raw`,
			);
		}
		if (url.includes('cubeId')) {
			assert.match(
				url,
				/encodeURIComponent\(\$parameter\["cubeId"\]\)/,
				`operation "${option.value}" must encode cubeId, got: ${url}`,
			);
			assert.doesNotMatch(
				url,
				/\{\{ \$parameter\["cubeId"\] \}\}/,
				`operation "${option.value}" must NOT interpolate cubeId raw`,
			);
		}
	}
});

test('the node never echoes the API key in any static config surface', () => {
	// Defense-in-depth: the compiled node description must not contain the raw
	// credential value anywhere except the credential-injection expression. The
	// key is only ever referenced as `$credentials.apiKey` inside the credential
	// class — never in the node's output mapping, subtitle, or routing.
	const serialized = JSON.stringify(desc);
	assert.doesNotMatch(serialized, /apiKey/, 'node description must not reference apiKey');
	assert.doesNotMatch(serialized, /X-API-KEY/i, 'node must not hardcode the auth header');
});

test('credential injects X-API-KEY and tests against an authenticated endpoint', () => {
	const cred = new KrovaApi();
	assert.equal(cred.name, 'krovaApi');

	const apiKeyField = cred.properties.find((p) => p.name === 'apiKey');
	assert.ok(apiKeyField, 'apiKey field exists');
	assert.equal(apiKeyField.typeOptions.password, true);

	const baseUrlField = cred.properties.find((p) => p.name === 'baseUrl');
	assert.equal(baseUrlField.default, 'https://krova.cloud/api/v1');

	// authenticate block injects the X-API-KEY header
	const header = cred.authenticate.properties.headers['X-API-KEY'];
	assert.equal(header, '={{ $credentials.apiKey }}');

	// The credential test MUST hit an authenticated endpoint so an invalid key
	// fails. /space requires X-API-KEY; the catalog endpoints are public and
	// would pass for any key.
	assert.equal(cred.test.request.url, '/space');
	assert.equal(cred.test.request.method, 'GET');
});
