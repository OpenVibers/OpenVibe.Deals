'use strict';
// What openvibe.deals tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this site really serves; Deals publishes no OpenAPI document or docs page, so
// neither is named. Prices are observations with the time they were seen, on the page and in its twin.
module.exports = {
    id: 'deals',
    name: 'OpenVibe.Deals',
    purpose: 'Deals from DealNews and the OpenVibe community, by shop, category and end date, with price watches and crowdfunding search; every price has its source and the time it was observed.',
    home: 'https://openvibe.deals',
    site: 'openvibe.deals',
    api: '/api/v1',
    policy: {
        auth: ['none', 'Network OIDC'],
        rateLimit: '240 API requests a minute per address; 60 form posts and 60 sign-in requests per 15 minutes',
    },
};
