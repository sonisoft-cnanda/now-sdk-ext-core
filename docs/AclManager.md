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
active. `SessionManager` keys its shared session by alias and elevated roles (`dev#elevated:security_admin`), so a
long-lived process can keep a plain and an elevated instance of one alias side by side. Two instances with the same alias
and the same roles still replace each other's session. `clearSession(alias)` clears the alias's elevated sessions too.
If the roles are not active, the login fails with `RoleElevationError`:

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

`list` needs at least one of `table`, `name` or `scope`. Reading needs no elevation. A role the session may not
read has an empty name (its `roleSysId` is still there): `security_admin` until the session is elevated, and `nobody`
and `maint` always, elevated or not. The Table API sometimes leaves such a name out of a row instead of sending it
empty; both read as `''`.

## Writing

Every write takes a target: the ACL's application (`scope`) and an in-progress `updateSet` of that application. An
installed Store application also needs `storeCustomization`, as with the metadata writer.

Every write needs the `write` verb of the installed policy. Setting a non-blank `script` needs `execute` as well: the
platform runs an ACL's script at every check of it (whether or not `advanced` is set, KB0685247), so it is code that
runs on the instance, like a background script or a scheduled job. Clearing a script (`script: ''`) needs only write.

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
- Before activating, `create` reads the role rows again. Unless they are exactly the requested roles it does not
  activate, and fails with `roles_not_applied`.
- If a step after the insert fails, `create` throws `AclPartialError`. Its `aclSysId` names the ACL, and `state`
  (`active`, `inactive`, `deleted` or `unknown`) is the ACL as read back; a create activates only as its last step. A
  policy refusal is re-thrown as it is (so `isPolicyRefusal` still recognises it), with `aclSysId` added.
- **Deleting an ACL deletes its role rows**, each captured as a DELETE.
- **An active record ACL cannot be deleted from its form.** The ACL table's own Delete is offered for a record ACL only
  while it is inactive, so `delete` deactivates one first, as a separate captured update. A deactivation refused before
  anything was written throws the writer's own error. On any failure after a write (the deactivation's own
  verification, the delete, a refusal, an unreadable state) it reactivates the ACL unless it is known active or gone, and
  throws `AclPartialError` with the state read back (a refusal is re-thrown with `aclSysId` and `aclState` added). When
  the state cannot be read at all it cannot tell whether the deactivation was written, so it reactivates and reports a
  partial delete to be safe.
- **A scoped application may not put a field ACL on another application's field.** The platform refuses ("A field level
  Access Control cannot protect an outside field") and the write fails with `write_not_applied`, carrying that message.
  A table ACL on another application's table is allowed.
- **The platform writes the description itself** on first save ("Allow read for records in …"). The result shows the
  saved value.
- An ACL created without roles, condition or script gets only `snc_internal`, so every internal user passes it.
  `warnings` says so.
- `addRole` and `removeRole` write the role row in the target application, which must be the ACL's own
  (`scope_mismatch` otherwise). Removing an ACL's only role leaves it in place in effect: the platform adds
  `snc_internal` back, and the result warns.

### Refusals

`AclError` is thrown before anything is written:

| Code | Meaning |
| --- | --- |
| `elevation_required` | The session does not have `security_admin` elevated. |
| `invalid_input` | A name, role, field or option failed validation (a name containing `javascript:` too). `detail` names which. |
| `filter_required` | `list` was called without `table`, `name` or `scope`. |
| `acl_not_found`, `type_not_found`, `operation_not_found`, `table_not_found`, `field_not_found`, `role_not_found` | What it says. |
| `role_already_present`, `role_not_present` | `addRole` / `removeRole` of a role the ACL already has, or does not have. |
| `confirmation_required` | `delete` without `confirm` repeating the sys_id. |
| `scope_mismatch` | `addRole` / `removeRole` with a target application other than the ACL's. |
| `roles_not_applied` | The ACL's roles did not match the requested roles before activation (thrown as the cause of `AclPartialError`). |
| `partially_applied` | Thrown as `AclPartialError`, described above. |

The form writes themselves can fail with the metadata writer's errors (`MetadataScopeError`,
`MetadataVerificationError`). Their `messages` carry the platform's own reason.
