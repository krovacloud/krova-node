import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

// What the domain operations actually send, built by n8n-core's own
// declarative router (RoutingNode) from the COMPILED node, the way `runNode`
// does it: parameters resolved with their defaults as n8n loads a saved
// workflow, then every property's routing merged into one request. Nothing is
// sent over the network; the test reads the request n8n would make.

const require = createRequire(import.meta.url);
const { NodeHelpers, Workflow } = require('n8n-workflow');
const { RoutingNode } = require(
	join(dirname(require.resolve('n8n-core')), 'execution-engine', 'routing-node.js'),
);
const { Krova } = await import('../dist/nodes/Krova/Krova.node.js');

const nodeType = new Krova();
const desc = nodeType.description;

/** The request n8n builds for these saved parameters. */
function requestFor(saved) {
	const parameters = NodeHelpers.getNodeParameters(desc.properties, saved, true, false, { typeVersion: 1 }, desc);
	const node = { id: '1', name: 'Krova', type: 'n8n-nodes-krova.krova', typeVersion: 1, position: [0, 0], parameters };
	const workflow = new Workflow({
		id: 't',
		nodes: [node],
		connections: {},
		active: false,
		nodeTypes: { getByName: () => nodeType, getByNameAndVersion: () => nodeType, getKnownTypes: () => ({}) },
	});
	const routing = new RoutingNode(
		{ node, nodeType, workflow, mode: 'manual', runExecutionData: null, connectionInputData: [], runIndex: 0 },
		nodeType,
	);
	const single = {
		getNodeParameter: (path, fallback) => NodeHelpers.getParameterValueByPath(parameters, path, '') ?? fallback,
		getExecuteData: () => undefined,
	};
	const request = { options: { qs: {}, body: {}, headers: {} }, preSend: [], postReceive: [], requestOperations: {} };
	for (const property of desc.properties) {
		const value = parameters[property.name];
		routing.mergeOptions(
			request,
			routing.getRequestOptionsFromParameters(single, property, 0, 0, '', { $value: value, $version: 1 }),
		);
	}
	// The body goes out as JSON, which is where an undefined key disappears.
	return { method: request.options.method, url: request.options.url, body: JSON.parse(JSON.stringify(request.options.body)) };
}

const ids = { resource: 'domain', spaceId: 'space_1', cubeId: 'cube_1' };

test('an Update saved before these fields sends exactly what it sent before', () => {
	// n8n saves only values that differ from the default, so an Update that
	// relied on the HTTP default has no originScheme stored at all.
	const req = requestFor({ ...ids, operation: 'update', mappingId: 'm_1' });
	assert.equal(req.method, 'PATCH');
	assert.equal(req.url, '/spaces/space_1/cubes/cube_1/domains/m_1');
	assert.deepEqual(req.body, { originScheme: 'http' });
});

test('an Update can change only the PROXY protocol, leaving the origin scheme alone', () => {
	const req = requestFor({
		...ids,
		operation: 'update',
		mappingId: 'm_1',
		originScheme: 'unchanged',
		domainAdditionalFields: { proxyProtocol: 'v2' },
	});
	assert.deepEqual(req.body, { proxyProtocol: 'v2' });
});

test('Off is sent as null, and the confirmation only when added', () => {
	const off = requestFor({
		...ids,
		operation: 'update',
		mappingId: 'm_1',
		originScheme: 'unchanged',
		domainAdditionalFields: { proxyProtocol: 'off', confirmMixedProxyProtocol: true },
	});
	assert.deepEqual(off.body, { proxyProtocol: null, confirmMixedProxyProtocol: true });

	const both = requestFor({
		...ids,
		operation: 'update',
		mappingId: 'm_1',
		originScheme: 'https',
		domainAdditionalFields: { proxyProtocol: 'v1' },
	});
	assert.deepEqual(both.body, { originScheme: 'https', proxyProtocol: 'v1' });
});

test('Create is unchanged without the new fields, and carries them when added', () => {
	const plain = requestFor({ ...ids, operation: 'create', domain: 'shop.example.com', port: 3000 });
	assert.equal(plain.method, 'POST');
	assert.equal(plain.url, '/spaces/space_1/cubes/cube_1/domains');
	assert.deepEqual(plain.body, { domain: 'shop.example.com', port: 3000, originScheme: 'http' });

	const withPp = requestFor({
		...ids,
		operation: 'create',
		domain: 'shop.example.com',
		port: 3000,
		domainAdditionalFields: { proxyProtocol: 'v1', confirmMixedProxyProtocol: true },
	});
	assert.deepEqual(withPp.body, {
		domain: 'shop.example.com',
		port: 3000,
		originScheme: 'http',
		proxyProtocol: 'v1',
		confirmMixedProxyProtocol: true,
	});
});
