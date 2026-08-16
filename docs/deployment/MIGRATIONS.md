# Schema Migrations and Rollback

Moving from memory storage to durable storage introduces schema evolution. This document outlines how schema versioning, forward migrations, and rollbacks are handled for the API repository layer.

## Schema Versioning

All persisted records in the system (e.g., `mailboxPolicy`, `postage`, `receipt`, `user`, `profile`, `credential`) are wrapped in an envelope containing a schema version:

```json
{
  "$v": 1,
  "data": { ... }
}
```

The system ensures that any unversioned records from legacy memory storage are implicitly treated as `$v: 1`.

### User Account, Profile & Credential Schemas (BETA-002)

With BETA-002, three core identity and access schemas are registered at version `$v: 1`:

- **`user` ($v: 1)**: Represents the core account record (`userId`, `address`, `email`, `username`, `status`, `createdAt`, `updatedAt`, `version`). User updates rely on `version` for optimistic concurrency control to prevent lost updates under race conditions.
- **`profile` ($v: 1)**: Stores public profile metadata (`userId`, `username`, `displayName`, `avatarUrl`, `bio`, `createdAt`, `updatedAt`).
- **`credential` ($v: 1)**: Stores private authentication secrets (`credentialId`, `userId`, `authMethod`, `secretHash`, `walletKeyRef`, `createdAt`, `updatedAt`). Stored separately and strictly isolated from public user and profile projections (`toPublicUser`, `toPublicProfile`).

### Secondary Indexes & Uniqueness Constraints

To guarantee unique `email`, `username`, and `address` lookups across durability layers:

1. **Unique Secondary Indexes**: Secondary index lookup keys (`user:email:<email>`, `user:username:<username>`, `user:address:<address>`) point to the primary `userId`.
2. **Atomic Writes**: `createUser` and `updateUser` operations validate index uniqueness within an atomic lock or Durable Object transaction, throwing a deterministic `ApiError(409, "conflict")` if any index is already bound.
3. **Index Cleanup on Mutation**: When a user's `email`, `username`, or `address` is updated, the previous index keys are automatically deleted in the same atomic transaction.

## Forward Migrations

Migrations are deterministic and handled "on-read" (lazy migration). When a record is fetched from the durable storage, the repository layer checks its `$v` attribute against the current version defined in code.

If the stored version is older than the current version, the system sequentially applies the necessary migrations from the record's version up to the current version. The migrated record is then validated against the current Zod schema.

When the record is subsequently written back to storage, it is written with the current schema version.

## Migration Order and Deployment

When introducing a new schema version, you must:

1. **Update the Zod Schema**: Modify the schema in `src/server/api/domain.ts`.
2. **Define the Migration**: Add a transformation function mapping the previous version (N-1) to the new version (N).
3. **Register the Migration**: Provide the migration and increment the `currentVersion` when calling `registerRecordSchema` in `src/server/api/context.ts`.
4. **Write Tests**: Add deterministic tests in `tests/unit/api/migrations.test.ts` verifying that a fixture of the old schema correctly migrates to the new schema.

### Deployment Order

1. **Deploy New Code**: Roll out the new code containing the migration logic.
2. **On-Read Migration**: As records are accessed, they are automatically migrated to the new schema.

## Rollback Guidance

If you need to roll back a deployment that introduced a schema migration, the following constraints apply:

- **Unsupported Newer Schemas**: If the older code encounters a record written with a newer schema version (which can happen if a record was written by the new code before rollback), it will fail safely and throw a `DataIntegrityError`. The older code **will not** attempt to read or corrupt the newer schema.
- **Rollback Procedure**: To fully roll back after records have been written in the new schema:
  1. Re-deploy the older codebase.
  2. Any records written in the newer schema will be inaccessible until they are either manually downgraded in the storage layer or the newer code is successfully rolled forward again.
  3. Avoid writing breaking schema changes unless necessary. For additive changes, consider keeping them backward-compatible (e.g., using `z.optional()`) rather than bumping the schema version, as this minimizes the risk of `DataIntegrityError` upon rollback.
