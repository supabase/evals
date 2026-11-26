-- Broken starting state (probe: health-unsupported-reg-types / Splinter lint 0018).
-- public.cached_relations has a 'relation_oid' column of type regclass. The OID
-- mapping is cluster-local and will not survive a logical backup/restore or
-- Postgres major-version upgrade.
CREATE TABLE public.cached_relations (
  id           bigserial PRIMARY KEY,
  relation_oid regclass NOT NULL
);

INSERT INTO public.cached_relations (relation_oid)
VALUES ('pg_class'::regclass), ('pg_attribute'::regclass), ('pg_index'::regclass);
