import {Logger} from "../../util/Logger";

export class GraphQLSubscriptionExtension {
	static RW_GRAPHQL_CHANNEL:string = '/rw/graphql';
	 static META_SUBSCRIBE:string = '/meta/subscribe';

	 _logger:Logger = new Logger('GraphQLSubscriptionExtension');
	graphQLSubscriptions:any = {};

	public isGraphQLChannel(channel:any) {
		return channel && channel.startsWith(GraphQLSubscriptionExtension.RW_GRAPHQL_CHANNEL);
	}

	addGraphQLChannel(channel:any, graphQLSubscription:any) {
		this.graphQLSubscriptions[channel] = graphQLSubscription;
	}

	removeGraphQLChannel(channel:any) {
		delete this.graphQLSubscriptions[channel];
	}

	getGraphQLSubscriptions() {
		return this.graphQLSubscriptions;
	}

	outgoing(message:any) {
		if (message.channel === GraphQLSubscriptionExtension.META_SUBSCRIBE && this.isGraphQLChannel(message.subscription)) {
			if (!message.ext)
				message.ext = {};

			if (this.graphQLSubscriptions[message.subscription]) {
				this._logger.debug('Subscribing with GraphQL subscription:' + this.graphQLSubscriptions[message.subscription]);
				message.ext.serializedGraphQLSubscription = this.graphQLSubscriptions[message.subscription];
			}
		}

		return message;
	}
}
