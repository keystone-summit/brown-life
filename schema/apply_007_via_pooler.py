"""
apply_007_via_pooler.py — apply 007_dblife_farm.sql (The Farm table, locked down).
Reads project password + ref from config.txt (override the path with
DBLIFE_CONFIG). Mirrors apply_002..006. Creates the table only — the farm
content is seeded separately and never committed (this repo is public).
"""
import os, sys, re, pathlib

HERE = pathlib.Path(__file__).resolve().parent
CONFIG = pathlib.Path(os.environ.get("DBLIFE_CONFIG") or HERE.parent.parent.parent / "config.txt")
SQL = HERE / "007_dblife_farm.sql"

cfg = CONFIG.read_text(encoding="utf-8", errors="replace")
m_pw  = re.search(r"project password\s*\n\s*(\S+)", cfg, re.IGNORECASE)
m_ref = re.search(r"https?://([a-z0-9]+)\.supabase\.co", cfg)
if not m_pw or not m_ref:
    print("FATAL: could not find project password or ref in config.txt", file=sys.stderr)
    sys.exit(2)
db_password, project_ref = m_pw.group(1), m_ref.group(1)
print(f"[info] project ref: {project_ref}")
sql_text = SQL.read_text(encoding="utf-8")

try:
    import psycopg2
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "psycopg2-binary"])
    import psycopg2

candidates = [
    ("aws-1-us-east-1.pooler.supabase.com", 5432, f"postgres.{project_ref}", db_password),
    ("aws-1-us-east-1.pooler.supabase.com", 6543, f"postgres.{project_ref}", db_password),
    ("db." + project_ref + ".supabase.co",   5432, "postgres",                db_password),
    ("aws-0-us-east-1.pooler.supabase.com", 5432, f"postgres.{project_ref}", db_password),
    ("aws-0-us-east-1.pooler.supabase.com", 6543, f"postgres.{project_ref}", db_password),
]
conn = None
for host, port, user, pw in candidates:
    try:
        print(f"[try] {host}:{port} user={user}")
        conn = psycopg2.connect(host=host, port=port, user=user, password=pw,
                                dbname="postgres", connect_timeout=10, sslmode="require")
        print(f"[ok]  connected via {host}:{port}")
        break
    except Exception as e:
        print(f"[fail] {host}:{port}: {type(e).__name__}: {str(e)[:160]}")
if conn is None:
    print("FATAL: could not connect via any host", file=sys.stderr)
    sys.exit(3)

conn.autocommit = False
cur = conn.cursor()
try:
    cur.execute(sql_text)
    conn.commit()
    print("[ok] migration committed")
except Exception as e:
    conn.rollback()
    print(f"FATAL: migration failed, rolled back: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(4)

# Verify: table exists, RLS on, no grants to the public PostgREST roles.
cur.execute("select relrowsecurity from pg_class where oid = 'public.dblife_farm'::regclass")
print("[post] dblife_farm RLS enabled:", cur.fetchone()[0])
cur.execute("""
  select grantee, string_agg(privilege_type, ',') from information_schema.role_table_grants
  where table_schema='public' and table_name='dblife_farm' and grantee in ('anon','authenticated')
  group by grantee
""")
print("[post] anon/authenticated grants (want none):", cur.fetchall())
cur.close(); conn.close()
print("[done]")
