# ============================================================
# backend.py - Serveur CP Engineer Pro - VERSION SÉCURISÉE
# ============================================================
# CORRECTIONS APPLIQUÉES (AUDIT) :
#   V01 : SECRET_KEY obligatoire en production (arrêt sinon)
#   V02 : ADMIN_PASSWORD obligatoire en production (arrêt sinon)
#   V03 : Rate limiting /api/login (Flask-Limiter + Redis fallback mémoire)
#   V04 : Support HttpOnly Cookie (JWT_SET_COOKIE=true) + CSRF token
#   V05 : Protection CSRF (Flask-WTF CSRFProtect) pour POST/PUT/PATCH/DELETE
#   V06 : Audit trail (table audit_log + endpoint /api/audit)
#   V07 : Fin de l'acceptation owner_id IS NULL (sauf admin)
#   V08 : ProxyFix activé (X-Forwarded-*)
#   V09 : Filtre owner_id systématique sur équipements/measurements
#   V12 : Temporisation uniforme sur login + constant-time
#   V13 : CORS depuis env, refus wildcard en prod
#
# ⭐ CORRECTIONS POST-AUDIT (CRITICAL / HIGH / MEDIUM) :
#   CRITICAL-02 : /api/login exempté de CSRFProtect (impossible de
#                 fournir un token CSRF avant authentification)
#   CRITICAL-03 : Table revoked_tokens + vérification jti dans
#                 token_required + révocation dans logout()
#   HIGH-05     : Refus de 'admin123' si bind non-localhost
#   MEDIUM-07   : Purge TTL de _login_attempts (anti-DoS mémoire)
#   MEDIUM-08   : Intégration Flask-Limiter réellement branchée
#   MEDIUM-09   : Refus de SECRET_KEY == JWT_SECRET_KEY en production
#   MEDIUM-11   : MAX_CONTENT_LENGTH configuré (anti-DoS payload)
#   CRITICAL-01 : /api/version expose useHttpOnlyCookie (source de
#                 vérité unique lue par le frontend)
#   + Journalisation structurée JSON
#   + Error handlers génériques (pas de stack trace)
#   + Validation stricte des entrées
#   + Serveur statique frontend (résolution CORS)
# ============================================================

import os
import sqlite3
import json
import time
import secrets
import hashlib
import hmac
import functools
import logging
import re
import math
import threading
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, Optional, Union, List

import jwt
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.middleware.proxy_fix import ProxyFix
from flask import Flask, request, jsonify, g, make_response, send_from_directory, abort
from flask_cors import CORS

# ─── Rate limiting (optionnel : Flask-Limiter + Redis) ───
try:
    from flask_limiter import Limiter
    from flask_limiter.util import get_remote_address
    HAS_LIMITER = True
except ImportError:
    HAS_LIMITER = False
    Limiter = None
    get_remote_address = None

# ─── CSRF (optionnel : Flask-WTF) ───
try:
    from flask_wtf.csrf import CSRFProtect, generate_csrf
    HAS_CSRF = True
except ImportError:
    HAS_CSRF = False
    CSRFProtect = None
    generate_csrf = lambda: ""

try:
    from coordUtils import CoordSystem
except ImportError:
    CoordSystem = None


# ============================================================
# 0. CONFIGURATION ENVIRONNEMENT
# ============================================================
ENVIRONMENT = os.environ.get('CP_ENV', 'development').lower()
IS_PRODUCTION = (ENVIRONMENT == 'production')
IS_TESTING = (ENVIRONMENT == 'testing')

BACKEND_VERSION = os.environ.get('CP_BACKEND_VERSION', '9.7.0')
API_VERSION = 'v1'
DATA_SCHEMA_VERSION = 3
_start_time = time.time()


# ============================================================
# 1. SECRETS — V01 / V02 / MEDIUM-09 : ARRÊT IMMÉDIAT EN PRODUCTION
# ============================================================
# ─── Chemin du fichier de secrets DEV persistants ───
_DEV_SECRETS_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    '.cp_dev_secrets.json'
)


def _load_dev_secrets() -> dict:
    """Charge le fichier de secrets DEV persistants (best-effort)."""
    try:
        if os.path.isfile(_DEV_SECRETS_FILE):
            with open(_DEV_SECRETS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
    except Exception as e:
        print(f"[DEV] ⚠️  Impossible de lire {_DEV_SECRETS_FILE}: {e}")
    return {}


def _save_dev_secrets(data: dict) -> None:
    """Persiste les secrets DEV sur disque (best-effort, chmod 600)."""
    try:
        with open(_DEV_SECRETS_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
        try:
            os.chmod(_DEV_SECRETS_FILE, 0o600)
        except (OSError, AttributeError):
            # Windows : chmod 600 non supporté nativement
            pass
    except Exception as e:
        print(f"[DEV] ⚠️  Impossible d'écrire {_DEV_SECRETS_FILE}: {e}")


def _require_secret(name: str, dev_default: Optional[str] = None) -> str:
    value = os.environ.get(name)
    if value and len(value) >= 32:
        return value
    if IS_PRODUCTION:
        raise RuntimeError(
            f"[FATAL] {name} est obligatoire en production et doit faire ≥ 32 caractères. "
            f"Arrêt du serveur pour éviter un démarrage en configuration non sécurisée."
        )

    # ─────────────────────────────────────────────────────────────
    # FIX 401 : en DEV, persister les secrets dans un fichier
    # -------------------------------------------------------------
    # Sans cette persistance, chaque redémarrage du backend génère
    # un nouveau JWT_SECRET_KEY, invalidant TOUS les tokens stockés
    # dans les navigateurs clients → erreurs 401 en boucle.
    #
    # Les secrets sont stockés dans .cp_dev_secrets.json (gitignoré).
    # Priorité :
    #   1. Variable d'environnement (CP_SECRET_KEY, etc.)
    #   2. Fichier .cp_dev_secrets.json
    #   3. Génération aléatoire (puis persistée)
    # ─────────────────────────────────────────────────────────────
    if dev_default is not None:
        print(f"[DEV] ⚠️  {name} non défini. Utilisation d'une valeur de DEV "
              f"(interdit en production).")
        return dev_default

    dev_secrets = _load_dev_secrets()
    if name in dev_secrets and len(dev_secrets[name]) >= 32:
        print(f"[DEV] {name} chargé depuis {_DEV_SECRETS_FILE} (persistant).")
        return dev_secrets[name]

    # Première génération → persister
    new_secret = secrets.token_urlsafe(48)
    dev_secrets[name] = new_secret
    _save_dev_secrets(dev_secrets)
    print(f"[DEV] {name} généré et persisté dans {_DEV_SECRETS_FILE}.")
    return new_secret

SECRET_KEY = _require_secret('CP_SECRET_KEY')

# MEDIUM-09 : JWT_SECRET_KEY doit être distinct de SECRET_KEY en production
_jwt_env = os.environ.get('CP_JWT_SECRET')
if IS_PRODUCTION:
    if not _jwt_env or len(_jwt_env) < 32:
        raise RuntimeError(
            "[FATAL] CP_JWT_SECRET est obligatoire en production (≥ 32 caractères) "
            "et doit être DISTINCT de CP_SECRET_KEY. Arrêt du serveur."
        )
    if _jwt_env == SECRET_KEY:
        raise RuntimeError(
            "[FATAL] CP_JWT_SECRET doit être différent de CP_SECRET_KEY. "
            "Réutiliser le même secret réduit la défense en profondeur. Arrêt du serveur."
        )
    JWT_SECRET_KEY = _jwt_env
else:
    JWT_SECRET_KEY = _jwt_env if _jwt_env else SECRET_KEY

# CSRF_SECRET_KEY : peut retomber sur SECRET_KEY en dev, distinct en prod
_csrf_env = os.environ.get('CP_CSRF_SECRET')
if IS_PRODUCTION:
    if not _csrf_env or len(_csrf_env) < 32:
        raise RuntimeError(
            "[FATAL] CP_CSRF_SECRET est obligatoire en production (≥ 32 caractères). "
            "Arrêt du serveur."
        )
    CSRF_SECRET_KEY = _csrf_env
else:
    CSRF_SECRET_KEY = _csrf_env if _csrf_env else SECRET_KEY

ADMIN_USERNAME = os.environ.get('CP_ADMIN_USERNAME', 'admin')
ADMIN_PASSWORD = os.environ.get('CP_ADMIN_PASSWORD')

# HIGH-05 : interdiction du mot de passe par défaut hors localhost
_BIND_HOST_PRE = os.environ.get('CP_BIND_HOST', '127.0.0.1')

if not ADMIN_PASSWORD:
    if IS_PRODUCTION:
        raise RuntimeError(
            "[FATAL] CP_ADMIN_PASSWORD est obligatoire en production. "
            "Arrêt du serveur."
        )
    # HIGH-05 : refus si bind non-localhost avec mot de passe faible
    if _BIND_HOST_PRE not in ('127.0.0.1', 'localhost', '::1'):
        raise RuntimeError(
            f"[FATAL] CP_ADMIN_PASSWORD doit être défini si le serveur "
            f"n'écoute pas sur localhost (CP_BIND_HOST={_BIND_HOST_PRE}). "
            f"Refus d'utiliser 'admin123' sur une interface réseau."
        )
    ADMIN_PASSWORD = 'admin123'
    print("[DEV] [ATTENTION] CP_ADMIN_PASSWORD non defini. Mot de passe 'admin123' utilise "
          "(interdit en production, interdit hors localhost).")

# ─── Cookie / CSRF configuration ───
USE_HTTPONLY_COOKIE = os.environ.get('CP_USE_HTTPONLY_COOKIE', 'false').lower() == 'true'
COOKIE_DOMAIN = os.environ.get('CP_COOKIE_DOMAIN') or None
COOKIE_SECURE = IS_PRODUCTION or os.environ.get('CP_COOKIE_SECURE', 'false').lower() == 'true'

# ─── CORS ───
_default_origins = 'http://localhost:5000,http://127.0.0.1:5000'
CORS_ORIGINS = os.environ.get('CP_CORS_ORIGINS', _default_origins)
CORS_ORIGINS_LIST = [o.strip() for o in CORS_ORIGINS.split(',') if o.strip()]
if IS_PRODUCTION and '*' in CORS_ORIGINS_LIST:
    raise RuntimeError("[FATAL] CORS wildcard interdit en production.")


# ============================================================
# 2. LOGGING STRUCTURÉ
# ============================================================
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(name)s %(message)s'
)
logger = logging.getLogger('cp_backend')


def audit_log(action: str, resource: str = None, resource_id: str = None,
              project_id: str = None, result: str = 'ok', extra: dict = None):
    """
    V06 : Audit trail structuré.
    Ne JAMAIS logger : mot de passe, JWT, secret, body complet.
    """
    entry = {
        'ts': datetime.now(timezone.utc).isoformat(),
        'user': getattr(g, 'user_id', None),
        'role': getattr(g, 'user_role', None),
        'action': action,
        'resource': resource,
        'resource_id': resource_id,
        'project_id': project_id,
        'result': result,
        'ip': _get_client_ip(),
        'ua': (request.user_agent.string[:200] if request.user_agent else None),
        'req_id': getattr(g, 'request_id', None),
    }
    if extra:
        entry['extra'] = extra
    logger.info(json.dumps(entry, ensure_ascii=False))
    _persist_audit(entry)


def _persist_audit(entry: dict):
    try:
        conn = get_db()
        conn.execute(
            '''INSERT INTO audit_log
               (ts, user_id, role, action, resource, resource_id,
                project_id, result, ip, user_agent, request_id, extra)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)''',
            (entry['ts'], entry['user'], entry['role'], entry['action'],
             entry['resource'], entry['resource_id'], entry['project_id'],
             entry['result'], entry['ip'], entry['ua'], entry['req_id'],
             json.dumps(entry.get('extra') or {}))
        )
        conn.commit()
        conn.close()
    except Exception as e:
        logger.warning(f"audit persist failed: {e}")


def _get_client_ip() -> str:
    # Derrière un proxy, X-Forwarded-For est fourni par ProxyFix
    return request.remote_addr or 'unknown'


# ============================================================
# 3. APPLICATION FLASK
# ============================================================
app = Flask(__name__)
app.config['SECRET_KEY'] = SECRET_KEY
app.config['WTF_CSRF_SECRET_KEY'] = CSRF_SECRET_KEY

# MEDIUM-11 : limite de taille des payloads (protection DoS)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50 MB

# V08 : ProxyFix (doit être appliqué AVANT tout usage de request.scheme/host)
app.wsgi_app = ProxyFix(
    app.wsgi_app,
    x_for=1, x_proto=1, x_host=1, x_port=1, x_prefix=1
)

# V05 : CSRF protection (si cookies activés)
csrf = None
if HAS_CSRF and USE_HTTPONLY_COOKIE:
    csrf = CSRFProtect(app)
    csrf.init_app(app)

# V13 : CORS restreint
CORS(
    app,
    origins=CORS_ORIGINS_LIST,
    supports_credentials=USE_HTTPONLY_COOKIE,
    allow_headers=['Content-Type', 'Authorization', 'X-CSRF-Token'],
    methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
)

# V03 / MEDIUM-08 : Rate limiting réellement branché
limiter = None
if HAS_LIMITER:
    limiter = Limiter(
        key_func=get_remote_address,
        app=app,
        storage_uri=os.environ.get('CP_REDIS_URL', 'memory://'),
        default_limits=[]  # appliqué au cas par cas
    )
    logger.info("Flask-Limiter activé (storage=%s)", os.environ.get('CP_REDIS_URL', 'memory://'))
else:
    logger.warning("Flask-Limiter non installé — fallback en mémoire interne")

# ─── Fallback rate-limit en mémoire si Flask-Limiter absent ───
_login_attempts: Dict[str, List[float]] = {}
LOGIN_WINDOW_SEC = 300   # 5 min
LOGIN_MAX_ATTEMPTS = 10


def _purge_login_attempts():
    """
    MEDIUM-07 : purge TTL des tentatives de login.
    Empêche la croissance illimitée de la structure en mémoire.
    """
    now = time.time()
    cutoff = now - LOGIN_WINDOW_SEC
    for ip in list(_login_attempts.keys()):
        attempts = [t for t in _login_attempts[ip] if t >= cutoff]
        if attempts:
            _login_attempts[ip] = attempts
        else:
            del _login_attempts[ip]


def _rate_limit_login(ip: str) -> bool:
    """Retourne True si la limite est dépassée."""
    _purge_login_attempts()
    now = time.time()
    attempts = _login_attempts.get(ip, [])
    attempts.append(now)
    _login_attempts[ip] = attempts
    return len(attempts) > LOGIN_MAX_ATTEMPTS


# ─── Request ID ───
@app.before_request
def _assign_request_id():
    g.request_id = secrets.token_hex(8)
    g.start_time = time.time()


# ============================================================
# 4. HEADERS DE SÉCURITÉ
# ============================================================
@app.after_request
def add_security_headers(response):
    # CSP stricte (script-src sans unsafe-inline)
    # NOTE HIGH-06 : 'unsafe-inline' reste pour les styles (chantier nonce à prévoir).
    #
    # FIX CSP : ajout de http://localhost:5000 et http://127.0.0.1:5000
    # dans connect-src pour couvrir les deux formes d'accès à l'API.
    # ------------------------------------------------------------
    # Sans cet ajout, un client qui accède à la page via
    # "http://127.0.0.1:5000" mais dont le code JS cible
    # "http://localhost:5000" se fait bloquer par le CSP.
    # ------------------------------------------------------------
    # NOTE : en production, ces URLs localhost ne sont pas
    # nécessaires et n'apparaissent pas (cf. branche IS_PRODUCTION).
    # ------------------------------------------------------------
    if IS_PRODUCTION:
        connect_src_extra = ""
        frame_ancestors = "'none'"
    else:
        connect_src_extra = " http://localhost:5000 http://127.0.0.1:5000"
        # Environnement de test uniquement : autorise l'affichage de
        # l'application dans l'aperçu hébergé (iframe) afin de pouvoir la
        # visualiser et la tester dans le navigateur. L'ancêtre réel est le
        # site d'aperçu (origine inconnue du backend), d'où '*' ici ; la
        # variable CP_PREVIEW_ORIGIN permet de restreindre si besoin.
        # En production, la CSP reste stricte : frame-ancestors 'none'.
        frame_ancestors = os.environ.get('CP_PREVIEW_ORIGIN', '*')

    csp = (
        "default-src 'self'; "
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://unpkg.com; "
        "script-src 'self' https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net; "
        "worker-src 'self' blob:; "
        "font-src 'self' https://cdnjs.cloudflare.com; "
        "img-src data: 'self' https://*.tile.openstreetmap.org; "
        "connect-src 'self'" + connect_src_extra +
        " https://*.tile.openstreetmap.org https://server.arcgisonline.com https://*.tile.opentopomap.org; "
        "object-src 'none'; base-uri 'self'; frame-ancestors " + frame_ancestors + "; form-action 'self'"
    )
    response.headers['Content-Security-Policy'] = csp
    response.headers['X-Content-Type-Options'] = 'nosniff'
    # X-Frame-Options : DENY en production. En environnement de test, l'en-tête
    # n'est PAS émis : la restriction d'iframe est portée par frame-ancestors
    # (prioritaire dans les navigateurs modernes) et l'aperçu doit pouvoir
    # afficher l'application depuis une origine différente.
    if IS_PRODUCTION:
        response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['Permissions-Policy'] = (
        'geolocation=(self), camera=(), microphone=(), payment=(), '
        'usb=(), serial=(), bluetooth=()'
    )
    response.headers['X-Request-ID'] = getattr(g, 'request_id', '')

    # V08 : HSTS en production (derrière HTTPS)
    if IS_PRODUCTION or COOKIE_SECURE:
        response.headers['Strict-Transport-Security'] = (
            'max-age=31536000; includeSubDomains; preload'
        )
    return response


# ============================================================
# 5. ERROR HANDLERS (V15 : pas de fuite d'info)
# ============================================================
@app.errorhandler(400)
def _e400(e):
    return jsonify({'error': 'Requête invalide', 'request_id': g.get('request_id')}), 400


@app.errorhandler(401)
def _e401(e):
    return jsonify({'error': 'Non authentifié', 'request_id': g.get('request_id')}), 401


@app.errorhandler(403)
def _e403(e):
    return jsonify({'error': 'Accès refusé', 'request_id': g.get('request_id')}), 403


@app.errorhandler(404)
def _e404(e):
    return jsonify({'error': 'Ressource introuvable', 'request_id': g.get('request_id')}), 404


@app.errorhandler(413)
def _e413(e):
    return jsonify({'error': 'Payload trop volumineux', 'request_id': g.get('request_id')}), 413


@app.errorhandler(429)
def _e429(e):
    return jsonify({'error': 'Trop de requêtes', 'request_id': g.get('request_id')}), 429


@app.errorhandler(500)
def _e500(e):
    logger.exception("Unhandled error")
    return jsonify({'error': 'Erreur interne', 'request_id': g.get('request_id')}), 500


# ============================================================
# 6. BASE DE DONNÉES
# ============================================================
# FIX-7 (2026-09-26) : chemin absolu par défaut pour éviter la dispersion du fichier SQLite
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_DB_PATH = os.path.join(_BASE_DIR, 'cp_data.db')
DB_PATH = os.environ.get('CP_DB_PATH', _DEFAULT_DB_PATH)


def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys=ON')
    conn.execute('PRAGMA journal_mode=WAL')
    return conn


def init_db():
    conn = get_db()
    cur = conn.cursor()

    cur.execute('''CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'viewer',
        created_at TEXT,
        disabled INTEGER DEFAULT 0
    )''')

    cur.execute('''CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT,
        type TEXT DEFAULT 'mixte',
        created_at TEXT,
        updated_at TEXT,
        data TEXT,
        owner_id TEXT,
        FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
    )''')

    cur.execute('''CREATE TABLE IF NOT EXISTS equipments (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        tag TEXT,
        type TEXT,
        surface REAL DEFAULT 0,
        included INTEGER DEFAULT 1,
        system_id TEXT,
        data TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )''')

    cur.execute('''CREATE TABLE IF NOT EXISTS field_measurements (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        asset_id TEXT, asset_tag TEXT, date TEXT,
        pot_on REAL, pot_off REAL, polarization REAL,
        compliant INTEGER, operator TEXT, temperature REAL,
        ref_electrode TEXT, system_id TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )''')

    cur.execute('''CREATE TABLE IF NOT EXISTS groundbeds (
        id TEXT PRIMARY KEY, name TEXT, parameters TEXT, results TEXT,
        coordinates TEXT, version INTEGER, created_at TEXT, updated_at TEXT,
        project_id TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )''')

    cur.execute('''CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY, timestamp TEXT, module TEXT,
        project_id TEXT, project_name TEXT,
        system_id TEXT, system_name TEXT,
        action TEXT, result TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )''')

    # V06 : Audit trail
    cur.execute('''CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        user_id TEXT, role TEXT,
        action TEXT NOT NULL,
        resource TEXT, resource_id TEXT, project_id TEXT,
        result TEXT, ip TEXT, user_agent TEXT, request_id TEXT,
        extra TEXT
    )''')
    cur.execute('CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts)')
    cur.execute('CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id)')

    # ⭐ CRITICAL-03 : table de révocation JWT
    cur.execute('''CREATE TABLE IF NOT EXISTS revoked_tokens (
        jti TEXT PRIMARY KEY,
        revoked_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
    )''')
    cur.execute('CREATE INDEX IF NOT EXISTS idx_revoked_expires ON revoked_tokens(expires_at)')

    cur.execute('CREATE INDEX IF NOT EXISTS idx_equipments_project ON equipments(project_id)')
    cur.execute('CREATE INDEX IF NOT EXISTS idx_measurements_project ON field_measurements(project_id)')
    cur.execute('CREATE INDEX IF NOT EXISTS idx_groundbeds_project ON groundbeds(project_id)')

    conn.commit()
    conn.close()
    logger.info("DB initialisée (schema v%d)", DATA_SCHEMA_VERSION)


init_db()


# ─── Nettoyage périodique des tokens expirés (CRITICAL-03) ───
def _cleanup_expired_revoked_tokens():
    """Supprime les entrées de revoked_tokens dont exp < maintenant."""
    try:
        conn = get_db()
        now_iso = datetime.now(timezone.utc).isoformat()
        cur = conn.execute('DELETE FROM revoked_tokens WHERE expires_at < ?', (now_iso,))
        deleted = cur.rowcount
        conn.commit()
        conn.close()
        if deleted:
            logger.info("Cleanup revoked_tokens: %d entrées supprimées", deleted)
    except Exception as e:
        logger.warning("Cleanup revoked_tokens échoué: %s", e)


def _start_cleanup_thread():
    """Thread daemon de nettoyage périodique (toutes les heures)."""
    def loop():
        while True:
            time.sleep(3600)
            _cleanup_expired_revoked_tokens()
    t = threading.Thread(target=loop, daemon=True, name='cp-revoked-cleanup')
    t.start()
    logger.info("Thread de nettoyage revoked_tokens démarré")


if not IS_TESTING:
    _start_cleanup_thread()


# ============================================================
# 7. AUTHENTIFICATION — V04 (HttpOnly Cookie) + V12 (timing)
# ============================================================
def _build_token(user_row) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        'user_id': user_row['id'],
        'role': user_row['role'],
        'iat': int(now.timestamp()),
        'exp': int((now + timedelta(hours=24)).timestamp()),
        'jti': secrets.token_hex(8),
    }
    return jwt.encode(payload, JWT_SECRET_KEY, algorithm='HS256')


def _extract_token_from_request() -> Optional[str]:
    """
    Priorité :
      1. Cookie HttpOnly (si USE_HTTPONLY_COOKIE)
      2. En-tête Authorization: Bearer (compat legacy)
    """
    if USE_HTTPONLY_COOKIE:
        cookie_token = request.cookies.get('cp_access_token')
        if cookie_token:
            return cookie_token
    auth = request.headers.get('Authorization')
    if not auth:
        return None
    parts = auth.split(' ', 1)
    if len(parts) != 2 or parts[0].lower() != 'bearer':
        return None
    token = parts[1].strip()
    return token or None


def token_required(f):
    @functools.wraps(f)
    def decorated(*args, **kwargs):
        token = _extract_token_from_request()
        if not token:
            return jsonify({'error': 'Authentification requise'}), 401
        try:
            data = jwt.decode(token, JWT_SECRET_KEY, algorithms=['HS256'])
        except jwt.ExpiredSignatureError:
            return jsonify({'error': 'Session expirée'}), 401
        except jwt.InvalidTokenError:
            return jsonify({'error': 'Token invalide'}), 401

        g.user_id = data.get('user_id')
        g.user_role = data.get('role', 'viewer')
        g.jwt_jti = data.get('jti')

        # ⭐ CRITICAL-03 & FIX-8 (2026-09-26) : vérification jti et utilisateur en une seule connexion DB
        conn = get_db()
        try:
            if g.jwt_jti:
                row_rev = conn.execute(
                    'SELECT 1 FROM revoked_tokens WHERE jti = ? LIMIT 1',
                    (g.jwt_jti,)
                ).fetchone()
                if row_rev:
                    return jsonify({'error': 'Session révoquée'}), 401

            row_user = conn.execute('SELECT disabled FROM users WHERE id = ?',
                                    (g.user_id,)).fetchone()
            if not row_user or row_user['disabled']:
                return jsonify({'error': 'Compte désactivé'}), 401
        finally:
            try:
                conn.close()
            except Exception:
                pass

        return f(*args, **kwargs)
    return decorated


def admin_required(f):
    @functools.wraps(f)
    def decorated(*args, **kwargs):
        if getattr(g, 'user_role', None) != 'admin':
            audit_log('ADMIN_ACTION_DENIED', result='denied')
            return jsonify({'error': 'Droits administrateur requis'}), 403
        return f(*args, **kwargs)
    return decorated


# ============================================================
# 8. LOGIN — V03 + V12 + CRITICAL-02
# ============================================================
def _login_handler():
    """
    Handler interne de login.
    Séparé pour permettre l'application du décorateur Flask-Limiter
    de manière conditionnelle.
    """
    # MEDIUM-08 : rate limiting distribué si Flask-Limiter est disponible
    # (décorateur appliqué ci-dessous via limiter.limit)
    ip = _get_client_ip()

    # Fallback mémoire toujours actif (défense en profondeur)
    if _rate_limit_login(ip):
        audit_log('LOGIN_RATE_LIMITED', result='denied', extra={'ip': ip})
        return jsonify({'error': 'Trop de tentatives. Réessayez plus tard.'}), 429

    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''

    # V12 : réponse uniforme + timing constant
    start = time.time()
    user = None
    if username and password:
        conn = get_db()
        user = conn.execute(
            'SELECT * FROM users WHERE username = ?', (username,)
        ).fetchone()
        conn.close()

    # Constant-time comparison même si user absent
    dummy_hash = 'pbkdf2:sha256:600000$dummy$' + ('0' * 64)
    stored_hash = user['password_hash'] if user else dummy_hash
    try:
        password_ok = check_password_hash(stored_hash, password) if password else False
    except Exception:
        password_ok = False

    # V12 : temporisation minimale (anti-énumération par timing)
    elapsed = time.time() - start
    min_delay = 0.25
    if elapsed < min_delay:
        time.sleep(min_delay - elapsed)

    if not user or not password_ok or user['disabled']:
        audit_log('LOGIN_FAILED', result='denied',
                  extra={'username_len': len(username)})
        return jsonify({'error': 'Identifiants invalides'}), 401

    token = _build_token(user)

    audit_log('LOGIN_SUCCESS', resource='user', resource_id=user['id'])

    resp = make_response(jsonify({
        'user_id': user['id'],
        'role': user['role'],
        # Le token n'est renvoyé dans le JSON QUE si on n'utilise pas HttpOnly
        'token': None if USE_HTTPONLY_COOKIE else token,
        'csrf_token': generate_csrf() if (HAS_CSRF and USE_HTTPONLY_COOKIE) else None,
    }))

    if USE_HTTPONLY_COOKIE:
        resp.set_cookie(
            'cp_access_token', token,
            httponly=True, secure=COOKIE_SECURE, samesite='Strict',
            domain=COOKIE_DOMAIN, max_age=86400, path='/'
        )
    return resp


# ⭐ MEDIUM-08 : branchement réel de Flask-Limiter
if HAS_LIMITER and limiter is not None:
    login = app.route('/api/login', methods=['POST'])(
        limiter.limit("10 per 5 minutes")(_login_handler)
    )
else:
    login = app.route('/api/login', methods=['POST'])(_login_handler)


# ⭐ CRITICAL-02 : exemption CSRF pour /api/login
# La CSRFProtect globale doit rester active sur toutes les autres routes.
#
# NOTE IMPORTANTE (post-audit) : l'exemption doit porter sur la vue
# RÉELLEMENT ENREGISTRÉE (`login`), et non sur `_login_handler`, car :
#   - si Flask-Limiter est actif, la vue enregistrée est un wrapper
#     produit par `limiter.limit(...)`. Exempter `_login_handler`
#     (la fonction interne) ne garantit pas que le wrapper soit exempt.
#   - Flask-WTF résout l'exemption par endpoint, et l'endpoint est
#     dérivé du nom de la vue enregistrée.
# Exempter `login` (le résultat final de `app.route(...)(...)`) est
# donc la seule méthode garantie quel que soit l'état de Flask-Limiter.
if HAS_CSRF and USE_HTTPONLY_COOKIE and csrf is not None:
    try:
        csrf.exempt(login)
        logger.info("CSRF exemption appliquée sur /api/login (vue enregistrée)")
    except Exception as e:
        logger.warning("Impossible d'exempter /api/login de CSRF: %s", e)


# ============================================================
# 9. LOGOUT — CRITICAL-03 (révocation jti)
# ============================================================
@app.route('/api/logout', methods=['POST'])
@token_required
def logout():
    audit_log('LOGOUT')

    # ⭐ CRITICAL-03 : révoquer le jti courant
    jti = getattr(g, 'jwt_jti', None)
    if jti:
        try:
            token = _extract_token_from_request()
            payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=['HS256'])
            exp_ts = payload.get('exp')
            if exp_ts:
                exp_iso = datetime.fromtimestamp(exp_ts, tz=timezone.utc).isoformat()
                conn = get_db()
                conn.execute(
                    'INSERT OR IGNORE INTO revoked_tokens '
                    '(jti, revoked_at, expires_at) VALUES (?,?,?)',
                    (jti, datetime.now(timezone.utc).isoformat(), exp_iso)
                )
                conn.commit()
                conn.close()
                logger.info("JWT révoqué: jti=%s exp=%s", jti, exp_iso)
        except Exception as e:
            logger.warning("Échec révocation JWT lors du logout: %s", e)

    resp = make_response(jsonify({'success': True}))
    if USE_HTTPONLY_COOKIE:
        resp.delete_cookie('cp_access_token', domain=COOKIE_DOMAIN, path='/')
    return resp


# ============================================================
# 10. HELPER D'AUTORISATION PROJET — V07 / V09
# ============================================================
def _assert_project_access(conn, project_id: str, write: bool = False) -> bool:
    """
    Vérifie que l'utilisateur a accès au projet.
    - admin : accès total
    - sinon : owner_id doit correspondre (NULL n'est PLUS accepté)
    """
    row = conn.execute(
        'SELECT owner_id FROM projects WHERE id = ?', (project_id,)
    ).fetchone()
    if not row:
        return False
    if g.user_role == 'admin':
        return True
    if row['owner_id'] is None:
        # V07 : plus d'accès implicite aux orphelins
        return False
    return row['owner_id'] == g.user_id


# ============================================================
# 11. VALIDATION DES ENTRÉES
# ============================================================
ID_RE = re.compile(r'^[A-Za-z0-9\-_]{1,64}$')
# FIX 400 : autoriser les espaces dans les tags.
# ------------------------------------------------------------
# Le frontend (ICCPOptimizationEngine._applyOptimalGB) génère
# des tags comme "Groundbed optimal" (avec un espace). Refuser
# l'espace provoquait un 400 en boucle sur POST /api/equipments.
# ------------------------------------------------------------
TAG_RE = re.compile(r'^[A-Za-z0-9\-_ ]{1,50}$')


def _validate_project_payload(data: dict):
    if not isinstance(data, dict):
        raise ValueError('Payload invalide')
    pid = data.get('id')
    name = data.get('name')
    if not pid or not ID_RE.match(str(pid)):
        raise ValueError('ID projet invalide')
    if not name or len(str(name)) > 100:
        raise ValueError('Nom projet invalide')


def _validate_equipment_payload(data: dict):
    if not isinstance(data, dict):
        raise ValueError('Payload invalide')
    if not data.get('id') or not ID_RE.match(str(data['id'])):
        raise ValueError('ID équipement invalide')
    if not data.get('tag') or not TAG_RE.match(str(data['tag'])):
        raise ValueError('Tag invalide')
    if not data.get('projectId') or not ID_RE.match(str(data['projectId'])):
        raise ValueError('projectId invalide')
    if data.get('surface') is not None:
        s = float(data['surface'])
        if not (0 <= s <= 1e9):
            raise ValueError('Surface hors plage')
    coords = data.get('coordinates')
    if coords is not None and not _validate_coordinates(coords):
        raise ValueError('Coordonnées GPS invalides')


def _validate_coordinates(coords) -> bool:
    if coords is None:
        return True

    # ─────────────────────────────────────────────────────────────
    # FIX 500 : CoordSystem.validate_coordinates est une méthode
    # d'INSTANCE (définie avec `self` dans coordUtils.py).
    # Il faut d'abord instancier la classe avant d'appeler la méthode.
    # Un try/except large garantit qu'aucun TypeError ne puisse
    # remonter en 500 INTERNAL SERVER ERROR.
    # ─────────────────────────────────────────────────────────────
    if CoordSystem is not None:
        try:
            cs = CoordSystem()  # ref_lat/ref_lon/ref_alt ont des valeurs par défaut
            validator = getattr(cs, 'validate_coordinates', None)
            if callable(validator):
                return bool(validator(coords))
        except (TypeError, ValueError, AttributeError) as e:
            logger.debug("CoordSystem.validate_coordinates a échoué (%s) — fallback local", e)
        except Exception as e:
            logger.warning("Erreur inattendue dans CoordSystem (%s) — fallback local", e)

    # Fallback local (défense en profondeur : toujours exécuté si
    # l'appel CoordSystem échoue ou n'est pas disponible)
    def _ok(lat, lon):
        try:
            lat = float(lat); lon = float(lon)
        except (TypeError, ValueError):
            return False
        return (math.isfinite(lat) and math.isfinite(lon)
                and -90 <= lat <= 90 and -180 <= lon <= 180)

    if isinstance(coords, dict):
        return _ok(coords.get('lat'), coords.get('lon'))
    if isinstance(coords, list) and coords:
        return all(
            isinstance(p, dict) and _ok(p.get('lat'), p.get('lon'))
            for p in coords
        )
    return False

# ============================================================
# 12. ROUTES PROJETS (avec audit + BOLA strict)
# ============================================================
def _paginate_args():
    try:
        limit = int(request.args.get('limit', 50))
    except (TypeError, ValueError):
        limit = 50
    try:
        offset = int(request.args.get('offset', 0))
    except (TypeError, ValueError):
        offset = 0
    limit = max(1, min(limit, 100))
    offset = max(0, offset)
    return limit, offset


@app.route('/api/projects', methods=['GET'])
@token_required
def get_projects():
    limit, offset = _paginate_args()
    conn = get_db()
    if g.user_role == 'admin':
        rows = conn.execute(
            'SELECT id, name, type, created_at, updated_at, owner_id '
            'FROM projects ORDER BY created_at DESC LIMIT ? OFFSET ?',
            (limit, offset)
        ).fetchall()
        total = conn.execute('SELECT COUNT(*) c FROM projects').fetchone()['c']
    else:
        rows = conn.execute(
            'SELECT id, name, type, created_at, updated_at, owner_id '
            'FROM projects WHERE owner_id = ? '
            'ORDER BY created_at DESC LIMIT ? OFFSET ?',
            (g.user_id, limit, offset)
        ).fetchall()
        total = conn.execute(
            'SELECT COUNT(*) c FROM projects WHERE owner_id = ?',
            (g.user_id,)
        ).fetchone()['c']
    conn.close()
    return jsonify({'items': [dict(r) for r in rows], 'total': total,
                    'limit': limit, 'offset': offset})


@app.route('/api/projects/<project_id>', methods=['GET'])
@token_required
def get_project(project_id):
    if not ID_RE.match(project_id):
        return jsonify({'error': 'ID invalide'}), 400
    conn = get_db()
    if not _assert_project_access(conn, project_id):
        conn.close()
        audit_log('PROJECT_READ_DENIED', 'project', project_id, project_id, 'denied')
        return jsonify({'error': 'Introuvable'}), 404
    row = conn.execute('SELECT * FROM projects WHERE id = ?',
                       (project_id,)).fetchone()
    conn.close()
    d = dict(row)
    d['data'] = json.loads(d['data']) if d['data'] else None
    audit_log('PROJECT_READ', 'project', project_id, project_id)
    return jsonify(d)


@app.route('/api/projects', methods=['POST'])
@token_required
def create_project():
    data = request.get_json(silent=True) or {}
    try:
        _validate_project_payload(data)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    now = datetime.now(timezone.utc).isoformat()
    conn = get_db()
    try:
        conn.execute('BEGIN')
        conn.execute(
            'INSERT INTO projects (id, name, type, created_at, updated_at, data, owner_id) '
            'VALUES (?,?,?,?,?,?,?)',
            (data['id'], data['name'], data.get('type', 'mixte'),
             now, now, json.dumps(data.get('data', {})), g.user_id)
        )
        conn.commit()
    except sqlite3.IntegrityError:
        conn.rollback(); conn.close()
        return jsonify({'error': 'ID projet déjà utilisé'}), 409
    except Exception:
        conn.rollback(); conn.close()
        raise
    conn.close()
    audit_log('PROJECT_CREATE', 'project', data['id'], data['id'])
    return jsonify({'success': True, 'id': data['id']}), 201


@app.route('/api/projects/<project_id>', methods=['PUT'])
@token_required
def update_project(project_id):
    if not ID_RE.match(project_id):
        return jsonify({'error': 'ID invalide'}), 400

    data = request.get_json(silent=True) or {}

    conn = get_db()
    created = False
    try:
        conn.execute('BEGIN')

        # ─────────────────────────────────────────────────────────
        # FIX 404 : UPSERT (create if not exists)
        # ---------------------------------------------------------
        # Le frontend (storage-proxy.js) utilise TOUJOURS PUT,
        # jamais POST. Si le projet n'existe pas encore côté backend
        # (base fraîche, migration, réinitialisation), il faut le
        # créer au premier PUT au lieu de renvoyer 404 en boucle.
        # ─────────────────────────────────────────────────────────
        existing = conn.execute(
            'SELECT owner_id FROM projects WHERE id = ?', (project_id,)
        ).fetchone()

        if existing is None:
            # Création implicite (upsert)
            now_iso = datetime.now(timezone.utc).isoformat()
            project_name = (
                data.get('name')
                or (data.get('project') or {}).get('name')
                or project_id
            )
            project_type = (
                data.get('type')
                or (data.get('project') or {}).get('cpSystemType')
                or 'mixte'
            )
            # Sécurité : type autorisé uniquement
            if project_type not in ('iccp', 'anodes', 'mixte'):
                project_type = 'mixte'

            conn.execute(
                'INSERT INTO projects '
                '(id, name, type, created_at, updated_at, data, owner_id) '
                'VALUES (?,?,?,?,?,?,?)',
                (project_id, project_name, project_type,
                 now_iso, now_iso,
                 json.dumps(data),
                 g.user_id)
            )
            created = True
        else:
            # Projet existant → vérification des droits + update classique
            if not _assert_project_access(conn, project_id, write=True):
                conn.rollback(); conn.close()
                audit_log('PROJECT_UPDATE_DENIED', 'project', project_id,
                          project_id, 'denied')
                return jsonify({'error': 'Introuvable'}), 404

            conn.execute(
                'UPDATE projects SET data = ?, updated_at = ? WHERE id = ?',
                (json.dumps(data),
                 datetime.now(timezone.utc).isoformat(),
                 project_id)
            )

        conn.commit()
    except Exception:
        conn.rollback(); conn.close(); raise

    conn.close()

    audit_log(
        'PROJECT_CREATE_VIA_PUT' if created else 'PROJECT_UPDATE',
        'project', project_id, project_id,
        extra={'created': created}
    )

    return jsonify({'success': True, 'created': created})

@app.route('/api/projects/<project_id>', methods=['DELETE'])
@token_required
def delete_project(project_id):
    if not ID_RE.match(project_id):
        return jsonify({'error': 'ID invalide'}), 400
    conn = get_db()
    try:
        conn.execute('BEGIN')
        if not _assert_project_access(conn, project_id, write=True):
            conn.rollback(); conn.close()
            audit_log('PROJECT_DELETE_DENIED', 'project', project_id,
                      project_id, 'denied')
            return jsonify({'error': 'Introuvable'}), 404
        conn.execute('DELETE FROM projects WHERE id = ?', (project_id,))
        conn.commit()
    except Exception:
        conn.rollback(); conn.close(); raise
    conn.close()
    audit_log('PROJECT_DELETE', 'project', project_id, project_id)
    return jsonify({'success': True})


# ============================================================
# 13. ROUTES ÉQUIPEMENTS (V09 : filtre owner_id)
# ============================================================
@app.route('/api/projects/<project_id>/equipments', methods=['GET'])
@token_required
def get_equipments(project_id):
    if not ID_RE.match(project_id):
        return jsonify({'error': 'ID invalide'}), 400
    limit, offset = _paginate_args()
    conn = get_db()
    if not _assert_project_access(conn, project_id):
        conn.close()
        return jsonify({'error': 'Introuvable'}), 404
    rows = conn.execute(
        'SELECT id, project_id, tag, type, surface, included, system_id, data '
        'FROM equipments WHERE project_id = ? ORDER BY tag LIMIT ? OFFSET ?',
        (project_id, limit, offset)
    ).fetchall()
    total = conn.execute(
        'SELECT COUNT(*) c FROM equipments WHERE project_id = ?',
        (project_id,)
    ).fetchone()['c']
    conn.close()
    out = []
    for r in rows:
        d = dict(r)
        d['data'] = json.loads(d['data']) if d['data'] else {}
        out.append(d)
    return jsonify({'items': out, 'total': total, 'limit': limit, 'offset': offset})


@app.route('/api/equipments', methods=['POST'])
@token_required
def create_equipment():
    data = request.get_json(silent=True) or {}
    try:
        _validate_equipment_payload(data)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    conn = get_db()
    try:
        conn.execute('BEGIN')
        if not _assert_project_access(conn, data['projectId'], write=True):
            conn.rollback(); conn.close()
            return jsonify({'error': 'Projet non autorisé'}), 403
        full_data = {k: v for k, v in data.items()
                     if k not in ('id', 'projectId', 'tag', 'type',
                                  'surface', 'included', 'systemId')}
        conn.execute(
            'INSERT INTO equipments (id, project_id, tag, type, surface, '
            'included, system_id, data) VALUES (?,?,?,?,?,?,?,?)',
            (data['id'], data['projectId'], data['tag'],
             data.get('type', 'other'), float(data.get('surface', 0)),
             1 if data.get('included', True) else 0,
             data.get('systemId'), json.dumps(full_data))
        )
        conn.commit()
    except sqlite3.IntegrityError:
        conn.rollback(); conn.close()
        return jsonify({'error': 'Équipement existant'}), 409
    except Exception:
        conn.rollback(); conn.close(); raise
    conn.close()
    audit_log('EQUIPMENT_CREATE', 'equipment', data['id'], data['projectId'])
    return jsonify({'success': True, 'id': data['id']}), 201


@app.route('/api/equipments/<equipment_id>', methods=['PUT'])
@token_required
def update_equipment(equipment_id):
    if not ID_RE.match(equipment_id):
        return jsonify({'error': 'ID invalide'}), 400
    data = request.get_json(silent=True) or {}
    try:
        _validate_equipment_payload(data)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    conn = get_db()
    try:
        conn.execute('BEGIN')
        existing = conn.execute(
            'SELECT project_id FROM equipments WHERE id = ?', (equipment_id,)
        ).fetchone()
        if not existing:
            conn.rollback(); conn.close()
            return jsonify({'error': 'Introuvable'}), 404
        if not _assert_project_access(conn, existing['project_id'], write=True):
            conn.rollback(); conn.close()
            audit_log('EQUIPMENT_UPDATE_DENIED', 'equipment', equipment_id,
                      existing['project_id'], 'denied')
            return jsonify({'error': 'Accès refusé'}), 403
        full_data = {k: v for k, v in data.items()
                     if k not in ('id', 'projectId', 'tag', 'type',
                                  'surface', 'included', 'systemId')}
        conn.execute(
            'UPDATE equipments SET tag=?, type=?, surface=?, included=?, '
            'system_id=?, data=? WHERE id=?',
            (data['tag'], data.get('type', 'other'),
             float(data.get('surface', 0)),
             1 if data.get('included', True) else 0,
             data.get('systemId'), json.dumps(full_data), equipment_id)
        )
        conn.commit()
    except Exception:
        conn.rollback(); conn.close(); raise
    conn.close()
    audit_log('EQUIPMENT_UPDATE', 'equipment', equipment_id,
              existing['project_id'])
    return jsonify({'success': True})


@app.route('/api/equipments/<equipment_id>', methods=['DELETE'])
@token_required
def delete_equipment(equipment_id):
    if not ID_RE.match(equipment_id):
        return jsonify({'error': 'ID invalide'}), 400
    conn = get_db()
    try:
        conn.execute('BEGIN')
        existing = conn.execute(
            'SELECT project_id FROM equipments WHERE id = ?', (equipment_id,)
        ).fetchone()
        if not existing:
            conn.rollback(); conn.close()
            return jsonify({'error': 'Introuvable'}), 404
        if not _assert_project_access(conn, existing['project_id'], write=True):
            conn.rollback(); conn.close()
            audit_log('EQUIPMENT_DELETE_DENIED', 'equipment', equipment_id,
                      existing['project_id'], 'denied')
            return jsonify({'error': 'Accès refusé'}), 403
        conn.execute('DELETE FROM equipments WHERE id = ?', (equipment_id,))
        conn.commit()
    except Exception:
        conn.rollback(); conn.close(); raise
    conn.close()
    audit_log('EQUIPMENT_DELETE', 'equipment', equipment_id,
              existing['project_id'])
    return jsonify({'success': True})


# ============================================================
# 14. FULL SYNC — V06 : audit systématique
# ============================================================
@app.route('/api/projects/<project_id>/full-sync', methods=['POST'])
@token_required
def full_sync(project_id):
    if not ID_RE.match(project_id):
        return jsonify({'error': 'ID invalide'}), 400

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'Payload invalide'}), 400

    conn = get_db()
    deleted = set()
    equipments = []
    created_project = False
    try:
        conn.execute('BEGIN')

        # ─────────────────────────────────────────────────────────
        # FIX 404 : UPSERT projet (même logique que PUT).
        # ---------------------------------------------------------
        # Si le projet n'existe pas (base fraîche / migration), on le
        # crée avant toute opération sur les équipements. Sinon les
        # DELETE/INSERT equipments échoueront sur contrainte FK ou
        # retourneront silencieusement.
        # ─────────────────────────────────────────────────────────
        existing_project = conn.execute(
            'SELECT owner_id FROM projects WHERE id = ?', (project_id,)
        ).fetchone()

        if existing_project is None:
            now_iso = datetime.now(timezone.utc).isoformat()
            project_blob = data.get('project') or {}
            project_name = project_blob.get('name') or project_id
            project_type = project_blob.get('cpSystemType') or 'mixte'
            if project_type not in ('iccp', 'anodes', 'mixte'):
                project_type = 'mixte'

            conn.execute(
                'INSERT INTO projects '
                '(id, name, type, created_at, updated_at, data, owner_id) '
                'VALUES (?,?,?,?,?,?,?)',
                (project_id, project_name, project_type,
                 now_iso, now_iso,
                 json.dumps(data),
                 g.user_id)
            )
            created_project = True
            existing_ids = set()
        else:
            # Projet existant → vérification des droits
            if not _assert_project_access(conn, project_id, write=True):
                conn.rollback(); conn.close()
                audit_log('FULL_SYNC_DENIED', 'project', project_id,
                          project_id, 'denied')
                return jsonify({'error': 'Accès refusé'}), 403

            existing_ids = {r['id'] for r in conn.execute(
                'SELECT id FROM equipments WHERE project_id = ?',
                (project_id,)
            ).fetchall()}

        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            'UPDATE projects SET data=?, updated_at=? WHERE id=?',
            (json.dumps(data), now, project_id)
        )

        equipments = data.get('equipments', []) or []
        if not isinstance(equipments, list):
            conn.rollback(); conn.close()
            return jsonify({'error': 'equipments doit être une liste'}), 400

        new_ids = {eq.get('id') for eq in equipments if eq.get('id')}

        deleted = existing_ids - new_ids
        for eq_id in deleted:
            conn.execute('DELETE FROM equipments WHERE id = ?', (eq_id,))

        for eq in equipments:
            try:
                _validate_equipment_payload({**eq, 'projectId': project_id})
            except ValueError as e:
                conn.rollback(); conn.close()
                return jsonify({'error': f"Équipement invalide : {e}"}), 400

            eq_id = eq['id']
            full_data = {k: v for k, v in eq.items()
                         if k not in ('id', 'projectId', 'tag', 'type',
                                      'surface', 'included', 'systemId')}

            if eq_id in existing_ids:
                conn.execute(
                    'UPDATE equipments SET tag=?, type=?, surface=?, '
                    'included=?, system_id=?, data=? WHERE id=?',
                    (eq['tag'], eq.get('type', 'other'),
                     float(eq.get('surface', 0)),
                     1 if eq.get('included', True) else 0,
                     eq.get('systemId'), json.dumps(full_data), eq_id)
                )
            else:
                conn.execute(
                    'INSERT INTO equipments (id, project_id, tag, type, '
                    'surface, included, system_id, data) '
                    'VALUES (?,?,?,?,?,?,?,?)',
                    (eq_id, project_id, eq['tag'], eq.get('type', 'other'),
                     float(eq.get('surface', 0)),
                     1 if eq.get('included', True) else 0,
                     eq.get('systemId'), json.dumps(full_data))
                )

        conn.commit()
    except Exception:
        conn.rollback(); conn.close(); raise

    conn.close()

    audit_log('FULL_SYNC', 'project', project_id, project_id,
              extra={'equipments': len(equipments),
                     'deleted': len(deleted),
                     'created_project': created_project})

    return jsonify({'success': True, 'createdProject': created_project})

# ============================================================
# 15. AUDIT ENDPOINT (admin)
# ============================================================
@app.route('/api/audit', methods=['GET'])
@token_required
@admin_required
def get_audit():
    limit, offset = _paginate_args()
    conn = get_db()
    rows = conn.execute(
        'SELECT * FROM audit_log ORDER BY ts DESC LIMIT ? OFFSET ?',
        (limit, offset)
    ).fetchall()
    total = conn.execute('SELECT COUNT(*) c FROM audit_log').fetchone()['c']
    conn.close()
    return jsonify({'items': [dict(r) for r in rows], 'total': total,
                    'limit': limit, 'offset': offset})


# ============================================================
# 16. VERSION — CRITICAL-01 : expose useHttpOnlyCookie
# ============================================================
@app.route('/api/version', methods=['GET'])
def get_version():
    return jsonify({
        'application': 'CP Engineer Pro',
        'version': BACKEND_VERSION,
        'apiVersion': API_VERSION,
        'dataSchemaVersion': DATA_SCHEMA_VERSION,
        'environment': ENVIRONMENT,
        'timestamp': datetime.now(timezone.utc).isoformat(),
        # ⭐ CRITICAL-01 : source de vérité unique pour le frontend
        'useHttpOnlyCookie': USE_HTTPONLY_COOKIE,
        'cookieSecure': COOKIE_SECURE,
    })


# ============================================================
# 17. SERVEUR STATIQUE FRONTEND
# ============================================================
FRONTEND_DIR = os.environ.get(
    'CP_FRONTEND_DIR',
    os.path.abspath(os.path.dirname(__file__)) or os.path.abspath('.')
)

logger.info("Frontend directory: %s", FRONTEND_DIR)

_ALLOWED_EXTENSIONS = {
    '.html', '.htm',
    '.css',
    '.js', '.mjs', '.jsx',
    '.json', '.map',
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.txt', '.md',
    '.geojson',
    '.csv',
}

_FORBIDDEN_FILES = {
    'backend.py',
    'cp_data.db',
    'cp_data.db-wal',
    'cp_data.db-shm',
    '.env',
    '.env.local',
    '.env.production',
    'requirements.txt',
}
_FORBIDDEN_PATTERNS = [
    re.compile(r'\.py$', re.IGNORECASE),
    re.compile(r'\.pyc$', re.IGNORECASE),
    re.compile(r'\.sqlite3?$', re.IGNORECASE),
    re.compile(r'\.db$', re.IGNORECASE),
    re.compile(r'\.db-wal$', re.IGNORECASE),
    re.compile(r'\.db-shm$', re.IGNORECASE),
    re.compile(r'^\.env', re.IGNORECASE),
    re.compile(r'^\.git', re.IGNORECASE),
    re.compile(r'\.pem$', re.IGNORECASE),
    re.compile(r'\.key$', re.IGNORECASE),
    re.compile(r'\.crt$', re.IGNORECASE),
    re.compile(r'^__pycache__', re.IGNORECASE),
]


def _is_safe_path(path: str) -> bool:
    if not path:
        return False
    normalized = os.path.normpath(path).replace('\\', '/')
    if normalized.startswith('..') or normalized.startswith('/'):
        return False
    filename = os.path.basename(normalized).lower()
    if filename in {f.lower() for f in _FORBIDDEN_FILES}:
        return False
    for pattern in _FORBIDDEN_PATTERNS:
        if pattern.search(filename):
            return False
    parts = normalized.split('/')
    forbidden_dirs = {'.git', '__pycache__', '.venv', 'venv', 'node_modules'}
    for part in parts:
        if part.lower() in forbidden_dirs:
            return False
    _, ext = os.path.splitext(filename)
    if ext.lower() not in _ALLOWED_EXTENSIONS:
        return False
    return True


def _serve_static(rel_path: str):
    full_path = os.path.join(FRONTEND_DIR, rel_path)
    try:
        resolved = os.path.realpath(full_path)
        frontend_real = os.path.realpath(FRONTEND_DIR)
    except (OSError, ValueError):
        abort(400)

    if not resolved.startswith(frontend_real + os.sep) and resolved != frontend_real:
        logger.warning("[STATIC] Tentative path-traversal: %s → %s",
                       rel_path, resolved)
        abort(403)

    if not _is_safe_path(rel_path):
        logger.warning("[STATIC] Fichier interdit ou extension non autorisée: %s",
                       rel_path)
        abort(403)

    if not os.path.isfile(resolved):
        abort(404)

    return send_from_directory(FRONTEND_DIR, rel_path)


@app.route('/', methods=['GET'])
def serve_root():
    dashboard_path = os.path.join(FRONTEND_DIR, 'dashboard.html')
    fname = 'dashboard.html' if os.path.isfile(dashboard_path) else 'index.html'
    return _no_cache_html(make_response(send_from_directory(FRONTEND_DIR, fname)))

@app.route('/studio', methods=['GET'])
@app.route('/app', methods=['GET'])
@app.route('/workspace', methods=['GET'])
def serve_studio():
    index_path = os.path.join(FRONTEND_DIR, 'index.html')
    if not os.path.isfile(index_path):
        logger.error("[STATIC] index.html introuvable dans %s", FRONTEND_DIR)
        return jsonify({
            'error': 'index.html introuvable',
            'frontend_dir': FRONTEND_DIR,
            'hint': 'Définissez CP_FRONTEND_DIR si vos fichiers sont ailleurs.'
        }), 404
    return _no_cache_html(make_response(send_from_directory(FRONTEND_DIR, 'index.html')))



# ============================================================
# 17-bis. ROUTES DES PAGES HTML (SPA-like sans Node.js)
# ============================================================

@app.route('/api/v1/health', methods=['GET'])
def health_v1():
    """Endpoint de santé compatible avec le frontend React."""
    return jsonify({
        'status': 'UP',
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'uptimeSeconds': int(time.time() - _start_time),
        'version': BACKEND_VERSION,
    })


@app.route('/api/dashboard/summary', methods=['GET'])
def get_dashboard_summary():
    """
    Retourne les données et KPIs réels calculés de CP Engineer Pro :
    - Projets actifs (Projet EMK, etc.)
    - Canalisations (longueur réelle en km, surface, détails)
    - Conformité NACE (-850 mV CSE)
    - Postes de soutirage (rectifiers réels, courant ICCP débité)
    - Déversoirs et anodes MMO
    """
    try:
        conn = get_db()
        projects = conn.execute('SELECT id, name, type, created_at, updated_at, data FROM projects').fetchall()
        
        total_pipeline_len_m = 0.0
        total_pipeline_surf_m2 = 0.0
        pipelines_list = []
        rectifiers_list = []
        groundbeds_list = []
        total_iccp_current_A = 0.0
        total_rectifier_nominal_A = 0.0
        
        projects_summary = []
        _project_compliance = []
        for p in projects:
            p_id = p['id']
            p_name = p['name']
            p_type = p['type']
            p_data = json.loads(p['data']) if p['data'] else {}
            
            # Métadonnées réelles du projet (aucune valeur inventée en repli)
            proj_meta_early = p_data.get('project', {}) if isinstance(p_data, dict) else {}
            target_potential = proj_meta_early.get('targetPotential')
            project_standard = proj_meta_early.get('standard')

            # Conformité NACE calculée à partir des mesures terrain réellement
            # enregistrées (table field_measurements). Aucune mesure → N/A.
            meas_rows = conn.execute(
                'SELECT compliant FROM field_measurements WHERE project_id = ?', (p_id,)
            ).fetchall()
            meas_total = len(meas_rows)
            meas_ok = sum(1 for m in meas_rows if m['compliant'] == 1)
            compliance_pct = round(100.0 * meas_ok / meas_total, 1) if meas_total > 0 else None
            project_status = None
            if compliance_pct is not None:
                project_status = 'Conforme (mesures)' if compliance_pct >= 100.0 else 'Non conforme (mesures)'

            eq_rows = conn.execute('SELECT * FROM equipments WHERE project_id = ?', (p_id,)).fetchall()
            p_pipe_len = 0.0
            p_pipe_surf = 0.0
            p_rect_count = 0
            p_gb_count = 0
            
            for eq in eq_rows:
                eq_data = json.loads(eq['data']) if eq['data'] else {}
                eq_type = eq['type']
                dims = eq_data.get('dimensions', {})
                length_m = float(dims.get('longueur_m', 0) or 0)
                diam_m = float(dims.get('diametre_m', 0) or 0)
                surf = float(eq['surface'] or 0)
                
                if 'pipeline' in eq_type:
                    p_pipe_len += length_m
                    p_pipe_surf += surf
                    total_pipeline_len_m += length_m
                    total_pipeline_surf_m2 += surf
                    pipelines_list.append({
                        'id': eq['id'],
                        'tag': eq['tag'],
                        'projectId': p_id,
                        'projectName': p_name,
                        'type': eq_type,
                        'length_m': length_m,
                        'length_km': round(length_m / 1000.0, 2),
                        'diameter_mm': round(diam_m * 1000.0, 1) if diam_m else None,
                        'surface_m2': round(surf, 2),
                        'coating': eq_data.get('coatingType'),
                        'condition': eq_data.get('coatingCondition'),
                        'status': eq_data.get('status')
                    })
                elif 'rectifier' in eq_type:
                    p_rect_count += 1
                    nom_i = float(eq_data.get('nominalCurrent', 0) or eq_data.get('current', 0) or 0)
                    nom_v = float(eq_data.get('nominalVoltage', 0) or eq_data.get('voltage', 0) or 0)
                    total_rectifier_nominal_A += nom_i
                    rectifiers_list.append({
                        'id': eq['id'],
                        'tag': eq['tag'],
                        'projectId': p_id,
                        'projectName': p_name,
                        'model': eq_data.get('model'),
                        'nominalCurrent': nom_i or None,
                        'nominalVoltage': nom_v or None,
                        'power': eq_data.get('power'),
                        'status': eq_data.get('status')
                    })
                elif 'groundbed' in eq_type:
                    p_gb_count += 1
                    gb_res = eq_data.get('results', {})
                    groundbeds_list.append({
                        'id': eq['id'],
                        'tag': eq['tag'],
                        'projectId': p_id,
                        'projectName': p_name,
                        'anodeCount': dims.get('anodeCount'),
                        'totalDepth': dims.get('totalDepth'),
                        'R_total': gb_res.get('R_total'),
                        'lifeDesign': gb_res.get('lifeDesign')
                    })
            
            iccp_data = p_data.get('iccp', {})
            cp_data = p_data.get('cp', {})
            proj_meta = p_data.get('project', {})
            
            calc_i = float(iccp_data.get('current', 0) or cp_data.get('current', 0) or 0)
            total_iccp_current_A += calc_i
            
            projects_summary.append({
                'id': p_id,
                'name': p_name,
                'type': p_type,
                'standard': project_standard,
                'targetPotential': target_potential,
                'pipelineLengthKm': round(p_pipe_len / 1000.0, 2),
                'pipelineSurfaceM2': round(p_pipe_surf, 2),
                'rectifiersCount': p_rect_count,
                'groundbedsCount': p_gb_count,
                'iccpCurrentA': round(calc_i, 3),
                'naceCompliancePercent': compliance_pct,
                'measurementsCount': meas_total,
                'status': project_status,
                'updatedAt': p['updated_at']
            })
            _project_compliance.append((meas_ok, meas_total))
        
        conn.close()
        
        total_km = round(total_pipeline_len_m / 1000.0, 2)

        global_meas_total = sum(t for _, t in _project_compliance)
        global_meas_ok = sum(o for o, _ in _project_compliance)
        global_compliance = (round(100.0 * global_meas_ok / global_meas_total, 1)
                             if global_meas_total > 0 else None)
        
        return jsonify({
            'engineer': {
                'name': 'Ing. Mustapha Korichi',
                'title': 'Senior Cathodic Protection Specialist & Pipeline Corrosion Expert',
                'certification': 'NACE Level 4 CP Specialist / ISO 15589 Senior Expert',
                'avatar': 'MK'
            },
            'kpis': {
                'protectedNetworkKm': total_km,
                'protectedNetworkKmFormatted': f"{total_km:.2f} km",
                'totalSurfaceM2': round(total_pipeline_surf_m2, 2),
                'naceCompliancePercent': global_compliance,
                'naceComplianceFormatted': (f"{global_compliance:g} %" if global_compliance is not None else None),
                'naceCriteria': None,
                'activeRectifiersCount': len(rectifiers_list),
                'activeRectifiersFormatted': f"{len(rectifiers_list)} actif{'s' if len(rectifiers_list) > 1 else ''}",
                'totalIccpCurrentA': round(total_iccp_current_A, 3),
                'totalIccpCurrentFormatted': f"{total_iccp_current_A:.3f} A ({round(total_iccp_current_A * 1000, 1)} mA)",
                'activeProjectsCount': len(projects_summary),
                'quotaUsage': f"{len(projects_summary)} / 10 projets"
            },
            'projects': projects_summary,
            'pipelines': pipelines_list,
            'rectifiers': rectifiers_list,
            'groundbeds': groundbeds_list
        })
    except Exception as e:
        logger.error("[DASHBOARD] Erreur get_dashboard_summary: %s", e)
        return jsonify({'error': str(e)}), 500

def _no_cache_html(resp):
    """Ajoute les en-têtes anti-cache HTTP sur les réponses HTML."""
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp


@app.route('/pricing', methods=['GET'])
def serve_pricing():
    pricing_path = os.path.join(FRONTEND_DIR, 'pricing.html')
    fname = 'pricing.html' if os.path.isfile(pricing_path) else 'index.html'
    return _no_cache_html(make_response(send_from_directory(FRONTEND_DIR, fname)))

@app.route('/status', methods=['GET'])
def serve_status():
    status_path = os.path.join(FRONTEND_DIR, 'status.html')
    fname = 'status.html' if os.path.isfile(status_path) else 'index.html'
    return _no_cache_html(make_response(send_from_directory(FRONTEND_DIR, fname)))

@app.route('/login', methods=['GET'])
@app.route('/auth', methods=['GET'])
def serve_login():
    login_path = os.path.join(FRONTEND_DIR, 'login.html')
    fname = 'login.html' if os.path.isfile(login_path) else 'index.html'
    return _no_cache_html(make_response(send_from_directory(FRONTEND_DIR, fname)))

@app.route('/dashboard', methods=['GET'])
def serve_dashboard():
    dashboard_path = os.path.join(FRONTEND_DIR, 'dashboard.html')
    fname = 'dashboard.html' if os.path.isfile(dashboard_path) else 'index.html'
    return _no_cache_html(make_response(send_from_directory(FRONTEND_DIR, fname)))


@app.route('/<path:path>', methods=['GET'])
def serve_static(path: str):
    if path.startswith('api/') or path == 'api':
        return jsonify({'error': 'Not found', 'request_id': g.get('request_id')}), 404
    return _serve_static(path)




# ============================================================
# 18. CRÉATION ADMIN
# ============================================================
def create_admin_user():
    conn = get_db()
    row = conn.execute('SELECT id FROM users WHERE username = ?',
                       (ADMIN_USERNAME,)).fetchone()
    if not row:
        conn.execute(
            'INSERT INTO users (id, username, password_hash, role, created_at) '
            'VALUES (?,?,?,?,?)',
            (secrets.token_hex(8), ADMIN_USERNAME,
             generate_password_hash(ADMIN_PASSWORD, method='pbkdf2:sha256:600000'),
             'admin', datetime.now(timezone.utc).isoformat())
        )
        conn.commit()
        logger.info("Admin '%s' créé", ADMIN_USERNAME)
    conn.close()


# ============================================================
# 19. DÉMARRAGE
# ============================================================
if __name__ == '__main__':
    create_admin_user()
    debug = (not IS_PRODUCTION) and os.environ.get('CP_DEBUG', 'false').lower() == 'true'
    bind_host = os.environ.get('CP_BIND_HOST', '127.0.0.1')
    logger.info("Démarrage CP Engineer Pro v%s (env=%s, cookie=%s, csrf=%s, limiter=%s)",
                BACKEND_VERSION, ENVIRONMENT,
                USE_HTTPONLY_COOKIE,
                HAS_CSRF and USE_HTTPONLY_COOKIE,
                HAS_LIMITER)
    logger.info("Frontend servi depuis : %s", FRONTEND_DIR)
    logger.info("Bind : %s:5000", bind_host)
    logger.info("Ouvrir : http://%s:5000", bind_host if bind_host != '0.0.0.0' else 'localhost')
    app.run(host=bind_host, port=5000, debug=debug)


# ============================================================
# FIN DE backend.py (VERSION 9.7.0 — AUDIT APPLIQUÉ)
# ============================================================