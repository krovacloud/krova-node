import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

// What the backup and backup-share operations actually send, built by n8n-core's own
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
	return {
		method: request.options.method,
		url: request.options.url,
		headers: request.options.headers,
		body: JSON.parse(JSON.stringify(request.options.body)),
	};
}

const ids = { spaceId: 'space_1' };

test('Backup List and Get read the space backups', () => {
	const list = requestFor({ ...ids, resource: 'backup', operation: 'list' });
	assert.equal(list.method, 'GET');
	assert.equal(list.url, '/spaces/space_1/backups');

	const get = requestFor({ ...ids, resource: 'backup', operation: 'get', backupId: 'bk_1' });
	assert.equal(get.url, '/spaces/space_1/backups/bk_1');

	const link = requestFor({ ...ids, resource: 'backup', operation: 'getDownloadLink', backupId: 'bk_1' });
	assert.equal(link.url, '/spaces/space_1/backups/bk_1/download');
});

test('Share posts the destination, and the idempotency key only when added', () => {
	const plain = requestFor({
		...ids,
		resource: 'backup',
		operation: 'share',
		backupId: 'bk_1',
		destinationSpaceId: 'space_2',
	});
	assert.equal(plain.method, 'POST');
	assert.equal(plain.url, '/spaces/space_1/backups/bk_1/shares');
	assert.deepEqual(plain.body, { destinationSpaceId: 'space_2' });
	assert.equal(plain.headers['Idempotency-Key'], undefined);

	const keyed = requestFor({
		...ids,
		resource: 'backup',
		operation: 'share',
		backupId: 'bk_1',
		destinationSpaceId: 'space_2',
		backupShareAdditionalFields: { idempotencyKey: 'share-once' },
	});
	assert.equal(keyed.headers['Idempotency-Key'], 'share-once');
	assert.deepEqual(keyed.body, { destinationSpaceId: 'space_2' });
});

test('Accept, Decline and Cancel post to the share and send no body fields', () => {
	for (const operation of ['accept', 'decline', 'cancel']) {
		const req = requestFor({ ...ids, resource: 'backupShare', operation, shareId: 'bs_1' });
		assert.equal(req.method, 'POST');
		assert.equal(req.url, `/spaces/space_1/backup-shares/bs_1/${operation}`);
		assert.deepEqual(req.body, {});
	}
	const list = requestFor({ ...ids, resource: 'backupShare', operation: 'list' });
	assert.equal(list.method, 'GET');
	assert.equal(list.url, '/spaces/space_1/backup-shares');
});
