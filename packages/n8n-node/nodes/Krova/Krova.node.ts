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
						name: 'Cube',
						value: 'cube',
					},
					{
						name: 'Catalog',
						value: 'catalog',
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
						name: 'Sleep',
						value: 'sleep',
						action: 'Sleep a cube',
						description: 'Sleep a running Cube (preserves data, stops compute billing)',
						routing: {
							request: {
								method: 'POST',
								url: '=/spaces/{{ encodeURIComponent($parameter["spaceId"]) }}/cubes/{{ encodeURIComponent($parameter["cubeId"]) }}/sleep',
							},
						},
					},
					{
						name: 'Wake',
						value: 'wake',
						action: 'Wake a cube',
						description: 'Wake a sleeping Cube',
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
						operation: ['get', 'delete', 'sleep', 'wake'],
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
					'Number of virtual CPUs. Defaults to a per-space cap of 16; an Orbit admin can raise this for your space.',
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
					'Amount of RAM in whole gibibytes. Defaults to a per-space cap of 32 GB; an Orbit admin can raise this for your space.',
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
					'Disk size in gibibytes (minimum 10, in steps of 5). Defaults to a per-space cap of 100 GB; an Orbit admin can raise this for your space.',
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
		],
	};
}
