/**
 * MetadataFormWriter instances allowed to write the access-control tables. Internal (not in the public barrel): only
 * AclManager adds to it, so the generic writer, and `nex metadata`, keep refusing ACLs.
 */
export const accessControlWriters = new WeakSet<object>();
