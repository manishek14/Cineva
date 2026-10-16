-- Enable required PostgreSQL extensions on the cineva database.
-- btree_gist is needed for EXCLUDE constraints on tstzrange (screening overlap).
-- pg_trgm is for future fuzzy search on movie titles.
-- uuid-ossp is not needed; TypeORM's uuid_generate_v4 is replaced by client-side uuid.

CREATE EXTENSION IF NOT EXISTS "btree_gist";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
