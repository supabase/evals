## Generating dump

`local/source.dump` is a `pg_dump --format=custom` binary dump of a plain-Postgres SaaS schema.

`source.sql` is the hand-authored source that produced the dump. To regenerate after a schema
change, edit `source.sql` then run:

```sh
./generate-fixture.sh
```

This spins up a throwaway `postgres:17.6` container, applies `source.sql`, dumps it, and writes
the result back to `local/source.dump`.

## Sequence sync

The tables use `bigserial` primary keys, which is an intentional gotcha. `pg_restore` restores
data but does not advance sequences to match the highest existing ID, so the first INSERT after
a naive restore would conflict. The eval checks that sequences are synced after the migration.
