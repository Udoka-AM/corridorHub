// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://docs.corridorfinance.tech',
	integrations: [
		starlight({
			title: 'Corridor Finance',
			description:
				'Payout infrastructure for money moving into and out of Africa. One settlement engine, run self-hosted as Corridor Hub or called as the hosted Corridor Ramp API, settling on Stellar.',
			logo: {
				light: './public/logo/light.svg',
				dark: './public/logo/dark.svg',
				alt: 'Corridor Finance',
				replacesTitle: true,
			},
			favicon: '/favicon.svg',
			customCss: ['./src/styles/corridor.css'],
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/Udoka-AM/corridorHub' },
			],
			editLink: {
				baseUrl: 'https://github.com/Udoka-AM/corridorHub/edit/main/apps/docs-site/',
			},
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ label: 'Introduction', slug: '' },
						{ slug: 'start/what-corridor-is' },
						{ slug: 'start/ten-minute-review' },
						{ slug: 'start/reading-paths' },
						{ slug: 'start/quickstart' },
					],
				},
				{
					label: 'Corridor Core',
					items: [
						{ slug: 'architecture/overview' },
						{ slug: 'architecture/hub-and-spoke' },
						{ slug: 'architecture/core-model' },
						{ slug: 'architecture/corridor-reference' },
						{ slug: 'architecture/ledger' },
						{ slug: 'architecture/routing' },
						{ slug: 'architecture/saga' },
						{ slug: 'architecture/reconciliation' },
					],
				},
				{
					label: 'Corridor Hub',
					items: [
						{ slug: 'architecture/keys-and-signers' },
						{ slug: 'architecture/security' },
						{ slug: 'architecture/treasury-console' },
					],
				},
				{
					label: 'Corridor Ramp',
					items: [{ slug: 'ramp/overview' }, { slug: 'ramp/deploy' }],
				},
				{
					label: 'Stellar and anchors',
					items: [
						{ slug: 'integrations/overview' },
						{ slug: 'integrations/stellar' },
						{ slug: 'integrations/sep-anchors' },
						{ slug: 'integrations/partner-interface' },
						{ slug: 'integrations/paj' },
						{ slug: 'integrations/cctp' },
						{ slug: 'integrations/solana' },
						{ slug: 'integrations/tron' },
						{ slug: 'integrations/base' },
					],
				},
				{
					label: 'Flows',
					items: [
						{ slug: 'flows/read-only-pilot' },
						{ slug: 'flows/payout-eur-kes' },
						{ slug: 'flows/importer-kes-cny' },
						{ slug: 'flows/failure-and-compensation' },
					],
				},
				{
					label: 'The opportunity',
					items: [
						{ slug: 'market/the-problem' },
						{ slug: 'market/global-opportunity' },
						{ slug: 'market/africa-stablecoin-flows' },
						{ slug: 'market/business-model' },
					],
				},
				{
					label: 'Status',
					items: [{ slug: 'status/evidence' }, { slug: 'status/roadmap' }],
				},
				{
					label: 'Decisions',
					collapsed: true,
					items: [{ autogenerate: { directory: 'decisions' } }],
				},
			],
		}),
	],
});
