// Directory index for the AMB (CometD) subsystem.
//
// This file is load-bearing for barrel generation, not just convenience. ctix
// skips a source file if — and only if — its own directory's index.ts
// re-exports it, so covering EVERY module here is what keeps the ~2,900 lines
// of transport internals out of the generated public barrel. Emptying this
// file, or omitting a module from it, makes ctix export that module publicly:
// that is exactly how `AuthenticatedWebSocket` used to leak out on its own
// while the rest of the folder stayed private.
//
// The curated public AMB surface is declared in src/PublicApi.ts and appended
// to the barrel by scripts/finalize-barrel.mjs.

export * from './AMBClient';
export * from './AMBConstants';
export * from './Channel';
export * from './ChannelListener';
export * from './ChannelRedirect';
export * from './cometd-nodejs-client';
export * from './CrossClientChannel';
export * from './EventManager';
export * from './FunctionQueue';
export * from './GraphQLSubscriptionExtension';
export * from './MessageClient';
export * from './MessageClientBuilder';
export * from './Properties';
export * from './ServerConnection';
export * from './SessionExtension';
export * from './SubscriptionCommandSender';
export * from './TokenManagementExtension';
export * from './XMLHttpRequest';
export * from './AuthenticatedWebSocket';
