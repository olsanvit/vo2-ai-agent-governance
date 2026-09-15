-- Oddělení MCP serverů od superuživatele roundnet.
--
-- PROČ: pravidlo zní „roundnet = superuser, jen pro migrace", ale mcp-usm, qnap-te-mcp
-- a mcp-sportreal se jím dnes přihlašují. Tři veřejně dostupné MCP servery tak jedou
-- s právy superuživatele nad celým clusterem. Každý dostane vlastní roli s právy
-- jen na svou databázi.
--
-- POUŽITÍ (na QNAPu, hesla se předávají proměnnými, nikdy inline):
--   (role postgres v pg16 neexistuje, superuser je roundnet)
--   docker exec -i pg16 psql -U roundnet -d postgres -v usm_pw="'<heslo>'" -v te_pw="'<heslo>'" \
--     -v sr_pw="'<heslo>'" -f mcp-least-privilege.sql
--
-- Hesla vygeneruj: openssl rand -base64 30 | tr -d '/+=' | head -c 32

\set ON_ERROR_STOP on

-- 1) Role (bez superuser, bez createdb, bez createrole)
CREATE ROLE mcp_usm_usr LOGIN PASSWORD :usm_pw;
CREATE ROLE mcp_te_usr  LOGIN PASSWORD :te_pw;
CREATE ROLE mcp_sr_usr  LOGIN PASSWORD :sr_pw;

-- 2) Práva na vlastní DB. MCP servery čtou i zapisují (upsert), proto DML ano, DDL ne —
--    schéma mění migrace pod roundnet.
\connect "UniSportManager"
GRANT CONNECT ON DATABASE "UniSportManager" TO mcp_usm_usr;
GRANT USAGE ON SCHEMA public TO mcp_usm_usr;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mcp_usm_usr;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mcp_usm_usr;
-- Nové tabulky vytvořené migracemi musí být dostupné automaticky:
ALTER DEFAULT PRIVILEGES FOR ROLE roundnet IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mcp_usm_usr;
ALTER DEFAULT PRIVILEGES FOR ROLE roundnet IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO mcp_usm_usr;

\connect "TopEleven"
GRANT CONNECT ON DATABASE "TopEleven" TO mcp_te_usr;
GRANT USAGE ON SCHEMA public TO mcp_te_usr;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mcp_te_usr;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mcp_te_usr;
ALTER DEFAULT PRIVILEGES FOR ROLE roundnet IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mcp_te_usr;
ALTER DEFAULT PRIVILEGES FOR ROLE roundnet IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO mcp_te_usr;

\connect "sportReal"
GRANT CONNECT ON DATABASE "sportReal" TO mcp_sr_usr;
GRANT USAGE ON SCHEMA public TO mcp_sr_usr;
-- mcp-sportreal jen čte (sr_get_*, run_select_sql) — zápis nedostává
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_sr_usr;
ALTER DEFAULT PRIVILEGES FOR ROLE roundnet IN SCHEMA public
  GRANT SELECT ON TABLES TO mcp_sr_usr;

-- 3) Ověření: žádná z rolí nesmí být superuser
\connect postgres
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole
FROM pg_roles WHERE rolname IN ('mcp_usm_usr','mcp_te_usr','mcp_sr_usr','roundnet') ORDER BY 1;

-- ROLLBACK (když se něco pokazí — kontejnery vrátit na roundnet a role zrušit):
--   DROP OWNED BY mcp_usm_usr; DROP ROLE mcp_usm_usr;   (totéž pro te / sr)
