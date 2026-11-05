# AclManager and role elevation

`AclManager` lists, creates, changes and deletes access controls (`sys_security_acl`) and their roles
(`sys_security_acl_role`). Every write goes through the record's form in a named application and update set, and is
verified by reading back the record and its capture, the same way [MetadataFormWriter](./MetadataFormWriter.md) works.

Changing an ACL needs the elevated `security_admin` role, so this guide also covers elevation.

## Role elevation

`security_admin` is an *elevated privilege* role. A session has it only after the user elevates, which is what the
**Elevate Role** item in the user menu does, and it lasts only for that session. The dialog calls the UI Impersonate
API:

- `GET /api/now/ui/impersonate/role` returns `{ roles: [{ name, description }], activeRoles: [...] }`. `roles` are the
  roles the user may elevate to.
- `POST /api/now/ui/impersonate/role` with `{ "roles": "security_admin" }` sets the session's elevated roles. The value
  is the complete comma-separated set, and `""` drops them all.

Core logs in more than one session per process: `SessionManager` shares one, and every `ServiceNowRequest` with its
own authentication handler logs in its own. A new process starts unelevated. So elevation is part of logging in:

```typescript
const instance = new ServiceNowInstance({ alias, credential, credentialProvider, elevatedRoles: ['security_admin'] });
```

Every session for that instance then elevates as it logs in, renewals included, and the login checks the roles are
active. If they are not, the login fails with `RoleElevationError`:

| Code | Meaning |
| --- | --- |
| `invalid_role` | A requested name is not a role name (refused when the instance is constructed). |
| `not_elevatable` | The user may not elevate to the role. `available` lists what they may elevate to. |
| `api_unavailable` | The instance does not offer the API, e.g. "UI Impersonate API" is listed in `glide.rest.apis.disabled`. |
| `not_applied` | The instance accepted the request, but the session does not have the role afterwards. |
| `request_failed` | Any other failure. Messages carry role names and HTTP statuses only. |

`new RoleElevation(instance).status()` reads the shared session's state: the roles available, and those elevated.

Elevation changes no instance data, so it is not a policy write, and a `--read-only` session may elevate. Whatever the
elevated session then changes (an ACL, a record) is classified as usual.

Only the user the role is assigned to can elevate. In the base system that is the System Administrator (`admin`).
With `glide.security.strict_elevate_privilege` false, admin sessions are elevated automatically; the login then finds
the role active and sends no POST.

## Reading

```typescript
const acls = new AclManager(instance);
await acls.list({ table: 'incident' });                // incident, incident.*, incident.<field>
await acls.list({ scope: { scope: 'x_acme_app' }, operation: 'write' });
await acls.get(sysId);
```

`list` needs at least one of `table`, `name` or `scope`. Reading needs no elevation. A role row naming
`security_admin` shows an empty role name until the session is elevated, because that role is hidden until then.

## Writing

Every write takes a target: the ACL's application (`scope`) and an in-progress `updateSet` of that application. An
installed Store application also needs `storeCustomization`, as with the metadata writer.

```typescript
const target = { scope: { scope: 'x_acme_app' }, updateSet: setSysId };

await acls.create({ ...target, operation: 'read', table: 'x_acme_app_request', field: 'cost', roles: ['x_acme_app.manager'] });
await acls.create({ ...target, type: 'ui_page', name: 'x_acme_app_dashboard', operation: 'read', roles: ['itil'] });
await acls.update(sysId, { ...target, condition: 'active=true' });
await acls.addRole(sysId, 'admin', target);
await acls.removeRole(sysId, 'itil', target);
await acls.delete(sysId, { ...target, confirm: sysId });
```

Each result has `acl` (read back after the change), `previous` (before it), `writes` (every verified form write, with
its capture), `removedAutomaticRoles` and `warnings`.

### The platform's rules

Seen on Australia (dev206299, 2026-11-05):

- **The platform adds `snc_internal` to an ACL that has no role**, at insert and again when the last role is removed.
  Roles on an ACL are alternatives, so `snc_internal` beside other roles lets every internal user pass. `create` with
  roles therefore inserts the ACL inactive, adds the roles, removes the platform's `snc_internal` (unless it was asked
  for), and only then activates it. The ACL is never active with less restriction than asked for. `removeRole` warns
  when the platform put `snc_internal` back.
- If a step after the insert fails, `create` throws `AclPartialError`. Its `aclSysId` names the ACL, which stays
  inactive.
- **Deleting an ACL deletes its role rows**, each captured as a DELETE.
- **An active record ACL cannot be deleted from its form.** The ACL table's own Delete is offered for a record ACL only
  while it is inactive, so `delete` deactivates one first, as a separate captured update.
- **A scoped application may not put a field ACL on another application's field.** The platform refuses ("A field level
  Access Control cannot protect an outside field") and the write fails with `write_not_applied`, carrying that message.
  A table ACL on another application's table is allowed.
- **The platform writes the description itself** on first save ("Allow read for records in …"). The result shows the
  saved value.
- An ACL with no role, condition or script inserts (with a warning), and restricts nothing. `warnings` says so.

### Refusals

`AclError` is thrown before anything is written:

| Code | Meaning |
| --- | --- |
| `elevation_required` | The session does not have `security_admin` elevated. |
| `invalid_input` | A name, role, field or option failed validation. `detail` names which. |
| `filter_required` | `list` was called without `table`, `name` or `scope`. |
| `acl_not_found`, `type_not_found`, `operation_not_found`, `table_not_found`, `field_not_found`, `role_not_found` | What it says. |
| `role_already_present`, `role_not_present` | `addRole` / `removeRole` of a role the ACL already has, or does not have. |
| `confirmation_required` | `delete` without `confirm` repeating the sys_id. |
| `partially_applied` | Thrown as `AclPartialError`, described above. |

The form writes themselves can fail with the metadata writer's errors (`MetadataScopeError`,
`MetadataVerificationError`). Their `messages` carry the platform's own reason.
