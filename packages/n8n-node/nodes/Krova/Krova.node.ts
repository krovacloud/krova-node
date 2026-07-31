import type { INodeType, INodeTypeDescription } from 'n8n-workflow';

/**
 * Krova Cloud node (declarative style).
 *
 * Talks to the Krova Cloud REST API (https://krova.cloud/api/v1) via n8n's
 * declarative routing — every operation maps to a real endpoint from the
 * published OpenAPI spec. Authentication is the X-API-KEY header, injected by
 * the KrovaApi credential.
 */
export class Krova implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Krova Cloud',
		name: 'krova',
		icon: 'file:krova.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
		description: 'Provision and manage Krova Cloud Cubes and read the platform catalog',
		defaults: {
			name: 'Krova Cloud',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'krovaApi',
				required: true,
			},
		],
		requestDefaults: {
			baseURL: '={{ $credentials.baseUrl }}',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
		},
		properties: [
			// ------------------------------------------------------------------
			//         Resource
			// ------------------------------------------------------------------
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Catalog',
						value: 'catalog',
					},
					{
						name: 'Cube',
						value: 'cube',
					},
					{
						name: 'Domain',
						value: 'domain',
					},
					{
						name: 'Snapshot',
						value: 'snapshot',
					},
					{
						name: 'TCP Mapping',
						value: 'tcpMapping',
					},
				],
				default: 'cube',
			},

			// ------------------------------------------------------------------
			//         Cube: Operations
			// ------------------------------------------------------------------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['cube'],
					},
				},
				options: [
					{
						name: 'Create',
						value: 'create',
						action: 'Create a cube',
						description: 'Create a new Cube in a Space',
						routing: {
							request: {
								method: 'POST',
								url: '=/spaces/{{ encodeURIComponent($parameter["spaceId"]) }}/cubes',
							},
						},
					},
					{
						name: 'Delete',
						value: 'delete',
						action: 'Delete a cube',
						description: 'Delete a Cube (asynchronous)',
						routing: {
							request: {
								method: 'DELETE',
								url: '=/spaces/{{ encodeURIComponent($parameter["spaceId"]) }}/cubes/{{ encodeURIComponent($parameter["cubeId"]) }}',
							},
						},
					},
					{
						name: 'Get',
						value: 'get',
						action: 'Get a cube',
						description: 'Retrieve a single Cube by ID',
						routing: {
							request: {
								method: 'GET',
								url: '=/spaces/{{ encodeURIComponent($parameter["spaceId"]) }}/cubes/{{ encodeURIComponent($parameter["cubeId"]) }}',
							},
						},
					},
					{
						name: 'List',
						value: 'list',
						action: 'List cubes',
						description: 'List all Cubes in a Space',
						routing: {
							request: {
								method: 'GET',
								url: '=/spaces/{{ encodeURIComponent($parameter["spaceId"]) }}/cubes',
							},
						},
					},
					{
						name: 'Power Off',
						value: 'power-off',
						action: 'Power off a cube',
						description: 'Power off a running Cube (preserves data, stops compute billing, frees host RAM)',
						routing: {
							request: {
								method: 'POST',
								url: '=/spaces/{{ encodeURIComponent($parameter["spaceId"]) }}/cubes/{{ encodeURIComponent($parameter["cubeId"]) }}/power-off',
							},
						},
					},
					{
						name: 'Restart',
						value: 'restart',
						action: 'Restart a cube',
						description:
							'Cold-restart a running Cube. Boots against the host current kernel, preserving the disk. The only way to pick up a refreshed guest kernel, as a reboot issued inside the Cube cannot change it. Requires the Cube to be running.',
						routing: {
							request: {
								method: 'POST',
								url: '=/spaces/{{ encodeURIComponent($parameter["spaceId"]) }}/cubes/{{ encodeURIComponent($parameter["cubeId"]) }}/restart',
							},
						},
					},
					{
						name: 'Start',
						value: 'wake',
						action: 'Start a cube',
						description: 'Start a stopped Cube (cold boot)',
						routing: {
							request: {
								method: 'POST',
								url: '=/spaces/{{ encodeURIComponent($parameter["spaceId"]) }}/cubes/{{ encodeURIComponent($parameter["cubeId"]) }}/wake',
							},
						},
					},
				],
				default: 'list',
			},

			// ------------------------------------------------------------------
			//         Cube: Shared fields
			// ------------------------------------------------------------------
			{
				displayName: 'Space ID',
				name: 'spaceId',
				type: 'string',
				required: true,
				default: '',
				description: 'The ID of the Space that owns the Cube',
				displayOptions: {
					show: {
						resource: ['cube'],
					},
				},
			},
			{
				displayName: 'Cube ID',
				name: 'cubeId',
				type: 'string',
				required: true,
				default: '',
				description: 'The ID of the Cube to act on',
				displayOptions: {
					show: {
						resource: ['cube'],
						operation: ['get', 'delete', 'power-off', 'restart', 'wake'],
					},
				},
			},

			// ------------------------------------------------------------------
			//         Cube: Create fields
			// ------------------------------------------------------------------
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				required: true,
				default: '',
				description: 'A human-readable name for the Cube',
				displayOptions: {
					show: {
						resource: ['cube'],
						operation: ['create'],
					},
				},
				routing: {
					send: {
						type: 'body',
						property: 'name',
					},
				},
			},
			{
				displayName: 'Image',
				name: 'image',
				type: 'string',
				required: true,
				default: '',
				description:
					'The OS image slug or ID to boot (see the Catalog → Get Images operation for available values)',
				displayOptions: {
					show: {
						resource: ['cube'],
						operation: ['create'],
					},
				},
				routing: {
					send: {
						type: 'body',
						property: 'image',
					},
				},
			},
			{
				displayName: 'SSH Public Key',
				name: 'sshPublicKey',
				type: 'string',
				required: true,
				default: '',
				description:
					'SSH public key written to /root/.ssh/authorized_keys at boot. Must start with ssh-ed25519, ssh-rsa, ecdsa-sha2-*, ssh-dss, or sk-*@openssh.com.',
				displayOptions: {
					show: {
						resource: ['cube'],
						operation: ['create'],
					},
				},
				routing: {
					send: {
						type: 'body',
						property: 'sshPublicKey',
					},
				},
			},
			{
				displayName: 'vCPU',
				name: 'vcpu',
				type: 'number',
				required: true,
				default: 1,
				typeOptions: {
					minValue: 1,
					numberStepSize: 1,
				},
				description:
					'Number of virtual CPUs. Defaults to a per-space cap of 16, which can be raised for your space.',
				displayOptions: {
					show: {
						resource: ['cube'],
						operation: ['create'],
					},
				},
				routing: {
					send: {
						type: 'body',
						property: 'resources.vcpu',
					},
				},
			},
			{
				displayName: 'RAM (GB)',
				name: 'ramGb',
				type: 'number',
				required: true,
				default: 1,
				typeOptions: {
					minValue: 1,
					numberStepSize: 1,
				},
				description:
					'Amount of RAM in whole gibibytes. Defaults to a per-space cap of 32 GB, which can be raised for your space.',
				displayOptions: {
					show: {
						resource: ['cube'],
						operation: ['create'],
					},
				},
				routing: {
					send: {
						type: 'body',
						property: 'resources.ramGb',
					},
				},
			},
			{
				displayName: 'Disk (GB)',
				name: 'diskGb',
				type: 'number',
				required: true,
				default: 10,
				typeOptions: {
					minValue: 10,
					numberStepSize: 5,
				},
				description:
					'Disk size in gibibytes (minimum 10, in steps of 5). Defaults to a per-space cap of 100 GB, which can be raised for your space.',
				displayOptions: {
					show: {
						resource: ['cube'],
						operation: ['create'],
					},
				},
				routing: {
					send: {
						type: 'body',
						property: 'resources.diskGb',
					},
				},
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: {
					show: {
						resource: ['cube'],
						operation: ['create'],
					},
				},
				options: [
					{
						displayName: 'Region',
						name: 'region',
						type: 'string',
						default: '',
						description:
							'Region slug from the Catalog → Get Regions operation. Leave empty to auto-select.',
						routing: {
							send: {
								type: 'body',
								property: 'region',
							},
						},
					},
					{
						displayName: 'User Data',
						name: 'userData',
						type: 'string',
						typeOptions: {
							rows: 4,
						},
						default: '',
						description: 'Cloud-init script run at first boot (max 16 KB)',
						routing: {
							send: {
								type: 'body',
								property: 'userData',
							},
						},
					},
				],
			},

			// ------------------------------------------------------------------
			//         Catalog: Operations
			// ------------------------------------------------------------------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['catalog'],
					},
				},
				options: [
					{
						name: 'Get Regions',
						value: 'getRegions',
						action: 'Get regions',
						description: 'List regions with available capacity',
						routing: {
							request: {
								method: 'GET',
								url: '/regions',
							},
						},
					},
					{
						name: 'Get Images',
						value: 'getImages',
						action: 'Get images',
						description: 'List available OS images',
						routing: {
							request: {
								method: 'GET',
								url: '/images',
							},
						},
					},
					{
						name: 'Get Pricing',
						value: 'getPricing',
						action: 'Get pricing',
						description: 'Get per-resource hourly rates and volume pricing tiers',
						routing: {
							request: {
								method: 'GET',
								url: '/pricing',
							},
						},
					},
				],
				default: 'getRegions',
			},

			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['domain'] } },
				options: [
					{
						name: 'Create',
						value: 'create',
						action: 'Attach domain',
						description: 'Attach a custom domain to a Cube',
						routing: {
							request: {
								method: 'POST',
								url: '=/spaces/{{ encodeURIComponent($parameter["spaceId"]) }}/cubes/{{ encodeURIComponent($parameter["cubeId"]) }}/domains',
							},
						},
					},
					{
						name: 'Delete',
						value: 'delete',
						action: 'Detach domain',
						description: 'Detach a custom domain from a Cube',
						routing: {
							request: {
								method: 'DELETE',
								url: '=/spaces/{{ encodeURIComponent($parameter["spaceId"]) }}/cubes/{{ encodeURIComponent($parameter["cubeId"]) }}/domains/{{ encodeURIComponent($parameter["mappingId"]) }}',
							},
						},
					},
					{
						name: 'List',
						value: 'list',
						action: 'List domains',
						description: 'List the custom domains attached to a Cube',
						routing: {
							request: {
								method: 'GET',
								url: '=/spaces/{{ encodeURIComponent($parameter["spaceId"]) }}/cubes/{{ encodeURIComponent($parameter["cubeId"]) }}/domains',
							},
						},
					},
				],
				default: 'list',
			},

			{
				displayName: 'Space ID',
				name: 'spaceId',
				type: 'string',
				required: true,
				default: '',
				description: 'The ID of the Space that owns the Cube',
				displayOptions: { show: { resource: ['domain'] } },
			},

			{
				displayName: 'Cube ID',
				name: 'cubeId',
				type: 'string',
				required: true,
				default: '',
				description: 'The ID of the Cube',
				displayOptions: { show: { resource: ['domain'] } },
			},

			{
				displayName: 'Domain',
				name: 'domain',
				type: 'string',
				required: true,
				default: '',
				description: 'The domain name to attach, e.g. app.example.com',
				displayOptions: { show: { resource: ['domain'], operation: ['create'] } },
				routing: { send: { type: 'body', property: 'domain' } },
			},

			{
				displayName: 'Port',
				name: 'port',
				type: 'number',
				required: true,
				default: 8080,
				description: 'The in-Cube port to route the domain to',
				typeOptions: { minValue: 1, maxValue: 65535 },
				displayOptions: { show: { resource: ['domain'], operation: ['create'] } },
				routing: { send: { type: 'body', property: 'port' } },
			},

			{
				displayName: 'Domain Mapping ID',
				name: 'mappingId',
				type: 'string',
				required: true,
				default: '',
				description: 'The domain mapping ID from the List operation',
				displayOptions: { show: { resource: ['domain'], operation: ['delete'] } },
			},

			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['snapshot'] } },
				options: [
					{
						name: 'Create',
						value: 'create',
						action: 'Create snapshot',
						description: 'Create a snapshot of a Cube disk',
						routing: {
							request: {
								method: 'POST',
								url: '=/spaces/{{ encodeURIComponent($parameter["spaceId"]) }}/cubes/{{ encodeURIComponent($parameter["cubeId"]) }}/snapshots',
							},
						},
					},
					{
						name: 'Delete',
						value: 'delete',
						action: 'Delete snapshot',
						description: 'Delete a snapshot',
						routing: {
							request: {
								method: 'DELETE',
								url: '=/spaces/{{ encodeURIComponent($parameter["spaceId"]) }}/cubes/{{ encodeURIComponent($parameter["cubeId"]) }}/snapshots/{{ encodeURIComponent($parameter["snapshotId"]) }}',
							},
						},
					},
					{
						name: 'List',
						value: 'list',
						action: 'List snapshots',
						description: 'List the disk snapshots for a Cube',
						routing: {
							request: {
								method: 'GET',
								url: '=/spaces/{{ encodeURIComponent($parameter["spaceId"]) }}/cubes/{{ encodeURIComponent($parameter["cubeId"]) }}/snapshots',
							},
						},
					},
					{
						name: 'Restore',
						value: 'restore',
						action: 'Restore cube',
						description: 'Restore a Cube disk from a snapshot, replacing the current disk',
						routing: {
							request: {
								method: 'POST',
								url: '=/spaces/{{ encodeURIComponent($parameter["spaceId"]) }}/cubes/{{ encodeURIComponent($parameter["cubeId"]) }}/restore',
								body: { snapshotId: '={{ $parameter["snapshotId"] }}' },
							},
						},
					},
				],
				default: 'list',
			},

			{
				displayName: 'Space ID',
				name: 'spaceId',
				type: 'string',
				required: true,
				default: '',
				description: 'The ID of the Space that owns the Cube',
				displayOptions: { show: { resource: ['snapshot'] } },
			},

			{
				displayName: 'Cube ID',
				name: 'cubeId',
				type: 'string',
				required: true,
				default: '',
				description: 'The ID of the Cube',
				displayOptions: { show: { resource: ['snapshot'] } },
			},

			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				description: 'Optional name for the snapshot',
				displayOptions: { show: { resource: ['snapshot'], operation: ['create'] } },
				routing: { send: { type: 'body', property: 'name' } },
			},

			{
				displayName: 'Snapshot ID',
				name: 'snapshotId',
				type: 'string',
				required: true,
				default: '',
				description: 'The snapshot ID from the List operation',
				displayOptions: { show: { resource: ['snapshot'], operation: ['delete', 'restore'] } },
			},

			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['tcpMapping'] } },
				options: [
					{
						name: 'Create',
						value: 'create',
						action: 'Create TCP mapping',
						description: 'Expose a Cube TCP port on the host',
						routing: {
							request: {
								method: 'POST',
								url: '=/spaces/{{ encodeURIComponent($parameter["spaceId"]) }}/cubes/{{ encodeURIComponent($parameter["cubeId"]) }}/tcp-mappings',
							},
						},
					},
					{
						name: 'Delete',
						value: 'delete',
						action: 'Delete TCP mapping',
						description: 'Remove a TCP port mapping',
						routing: {
							request: {
								method: 'DELETE',
								url: '=/spaces/{{ encodeURIComponent($parameter["spaceId"]) }}/cubes/{{ encodeURIComponent($parameter["cubeId"]) }}/tcp-mappings/{{ encodeURIComponent($parameter["mappingId"]) }}',
							},
						},
					},
					{
						name: 'List',
						value: 'list',
						action: 'List TCP mappings',
						description: 'List the TCP port mappings for a Cube',
						routing: {
							request: {
								method: 'GET',
								url: '=/spaces/{{ encodeURIComponent($parameter["spaceId"]) }}/cubes/{{ encodeURIComponent($parameter["cubeId"]) }}/tcp-mappings',
							},
						},
					},
				],
				default: 'list',
			},

			{
				displayName: 'Space ID',
				name: 'spaceId',
				type: 'string',
				required: true,
				default: '',
				description: 'The ID of the Space that owns the Cube',
				displayOptions: { show: { resource: ['tcpMapping'] } },
			},

			{
				displayName: 'Cube ID',
				name: 'cubeId',
				type: 'string',
				required: true,
				default: '',
				description: 'The ID of the Cube',
				displayOptions: { show: { resource: ['tcpMapping'] } },
			},

			{
				displayName: 'Cube Port',
				name: 'cubePort',
				type: 'number',
				required: true,
				default: 8080,
				description: 'The in-Cube port to expose',
				typeOptions: { minValue: 1, maxValue: 65535 },
				displayOptions: { show: { resource: ['tcpMapping'], operation: ['create'] } },
				routing: { send: { type: 'body', property: 'cubePort' } },
			},

			{
				displayName: 'Mapping ID',
				name: 'mappingId',
				type: 'string',
				required: true,
				default: '',
				description: 'The mapping ID from the List operation',
				displayOptions: { show: { resource: ['tcpMapping'], operation: ['delete'] } },
			},
		],
	};
}
