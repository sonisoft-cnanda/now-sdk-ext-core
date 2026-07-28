import {GraphQLSubscriptionExtension} from '../../../src/sn/amb/GraphQLSubscriptionExtension';

describe.skip('GraphQLSubscriptionExtension', () => {
	let graphQLSubscriptionExtension;

	beforeEach(() => {
		graphQLSubscriptionExtension = new GraphQLSubscriptionExtension();
	});

	describe('isGraphQLChannel', () => {
		it('returns true when channel is a graphql channel', () => {
			expect(graphQLSubscriptionExtension.isGraphQLChannel('/rw/graphql/somehash')).toBe(true);
		});

		it('returns false when channel is a graphql channel', () => {
			expect(graphQLSubscriptionExtension.isGraphQLChannel('/rw/notgraphql/somehash')).toBe(false);
		});
	});

	describe('addGraphQLChannel', () => {
		it('adds a GraphQL channel to the list', () => {
			graphQLSubscriptionExtension.addGraphQLChannel('/rw/graphql/somehash', 'some serialized subscription');
			expect(graphQLSubscriptionExtension.getGraphQLSubscriptions()['/rw/graphql/somehash']).toBe('some serialized subscription');
		});
	});

	describe('removeGraphQLChannel', () => {
		it('removes a GraphQL channel from the list', () => {
			graphQLSubscriptionExtension.addGraphQLChannel('/rw/graphql/somehash', 'some serialized subscription');
			graphQLSubscriptionExtension.removeGraphQLChannel('/rw/graphql/somehash');
			expect(graphQLSubscriptionExtension.getGraphQLSubscriptions()['/rw/graphql/somehash']).toBe(undefined);
		});
	});

	describe('outgoing', () => {
		it('returns original message if channel not /meta/subscribe', () => {
			const message = {
				channel : '/meta/handshake'
			};
			const newMessage = graphQLSubscriptionExtension.outgoing(message);
			expect(newMessage).toBe(message);
		});

		it('returns original message if channel not /meta/subscribe', () => {
			const message = {
				channel : '/meta/subscribe',
				subscription : '/rw/notgraphql/somehash'
			};
			const newMessage = graphQLSubscriptionExtension.outgoing(message);
			expect(newMessage).toBe(message);
		});

		it('adds serializedGraphQLSubscription to message', () => {
			const expectedMessage = {
				channel : '/meta/subscribe',
				subscription : '/rw/graphql/somehash',
				ext : {
					serializedGraphQLSubscription : 'some serialized subscription'
				}
			};

			const message = {
				channel : '/meta/subscribe',
				subscription : '/rw/graphql/somehash'
			};

			graphQLSubscriptionExtension.addGraphQLChannel('/rw/graphql/somehash', 'some serialized subscription');
			const newMessage = graphQLSubscriptionExtension.outgoing(message);
			expect(newMessage).toMatchObject(expectedMessage);
		});

		it('does not overwrite existing ext object', () => {
			const expectedMessage = {
				channel : '/meta/subscribe',
				subscription : '/rw/graphql/somehash',
				ext : {
					anotherProp : 'anotherValue',
					serializedGraphQLSubscription : 'some serialized subscription'
				}
			};

			const message = {
				channel : '/meta/subscribe',
				subscription : '/rw/graphql/somehash',
				ext : {
					anotherProp : 'anotherValue'
				}
			};

			graphQLSubscriptionExtension.addGraphQLChannel('/rw/graphql/somehash', 'some serialized subscription');
			const newMessage = graphQLSubscriptionExtension.outgoing(message);
			expect(newMessage).toMatchObject(expectedMessage);
		});

		it('only adds serializedGraphQLSubscription if it exists', () => {
			const expectedMessage = {
				channel : '/meta/subscribe',
				subscription : '/rw/graphql/somehash',
			};

			const message = {
				channel : '/meta/subscribe',
				subscription : '/rw/graphql/somehash',
			};

			const newMessage = graphQLSubscriptionExtension.outgoing(message);
			expect(newMessage).toMatchObject(expectedMessage);
		});
	});
});
