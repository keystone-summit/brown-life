"""
apply_001_via_pooler.py
=======================
Apply dblife schema 001_dblife_init.sql to the shared Supabase project.
Mirrors Member Hub apply_029_via_pooler.py — same host-fallback order.

Reads project password + ref from ..\\..\\config.txt.
"""
import sys, re, pathlib

HERE = pathlib.Path(__file__).resolve().parent
CONFIG = HERE.parent.parent.parent / "config.txt"
SQL = HERE / "001_dblife_init.sql"

cfg = CONFIG.read_text(encoding="utf-8", errors="replace")
m_pw  = re.search(r"project password\s*\n\s*(\S+)", cfg, re.IGNORECASE)
m_ref = re.search(r"https?://([a-z0-9]+)\.supabase\.co", cfg)
if not m_pw or not m_ref:
    print("FATAL: could not find project password or ref in config.txt", file=sys.stderr)
    sys.exit(2)
db_password = m_pw.group(1)
project_ref = m_ref.group(1)

print(f"[info] project ref: {project_ref}")
print(f"[info] sql file:    {SQL}")
sql_text = SQL.read_text(encoding="utf-8")
print(f"[info] sql bytes:   {len(sql_text)}")

try:
    import psycopg2
except ImportError:
    print("[info] installing psycopg2-binary ...")
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
        print(f"[fail] {host}:{port}: {type(e).__name__}: {str(e)[:200]}")

if conn is None:
    print("FATAL: could not connect via any host", file=sys.stderr)
    sys.exit(3)

conn.autocommit = False
cur = conn.cursor()

cur.execute("""
    select table_name from information_schema.tables
    where table_schema='public' and table_name like 'dblife_%'
    order by table_name
""")
pre = [r[0] for r in cur.fetchall()]
print(f"[pre] dblife_* tables present: {len(pre)} -> {pre}")

try:
    cur.execute(sql_text)
    conn.commit()
    print("[ok] migration committed")
except Exception as e:
    conn.rollback()
    print(f"FATAL: migration failed, rolled back: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(4)

cur.execute("""
    select table_name from information_schema.tables
    where table_schema='public' and table_name like 'dblife_%'
    order by table_name
""")
post = [r[0] for r in cur.fetchall()]
print(f"[post] dblife_* tables present: {len(post)} -> {post}")

cur.close()
conn.close()
print("[done]")
