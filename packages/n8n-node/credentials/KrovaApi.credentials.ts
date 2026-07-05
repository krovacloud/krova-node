import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class KrovaApi implements ICredentialType {
	name = 'krovaApi';

	displayName = 'Krova Cloud API';

	documentationUrl = 'https://krova.cloud';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Your Krova Cloud API key. Keys are scoped per Space and sent in the X-API-KEY header.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://krova.cloud/api/v1',
			description: 'The Krova Cloud API base URL. Override only for self-hosted or test endpoints.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'X-API-KEY': '={{ $credentials.apiKey }}',
			},
		},
	};

	// Validate against an AUTHENTICATED endpoint. `/space` resolves the Space the
	// key is scoped to and requires a valid X-API-KEY, so a missing/invalid/
	// revoked key fails the test. (The catalog endpoints — /regions, /images,
	// /pricing — are public and would report success for any key, even an empty
	// one.)
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{ $credentials.baseUrl }}',
			url: '/space',
			method: 'GET',
		},
	};
}
