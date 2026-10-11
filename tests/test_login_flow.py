"""Validation du flux de connexion legacy (mode JWT localStorage).

Reproduit le problème « login qui bloque » (boucle login <-> dashboard) :

  En mode legacy (CP_USE_HTTPONLY_COOKIE=false, défaut en dev), le
  dashboard.html appelle /api/dashboard/summary. Si le JWT stocké dans
  localStorage n'est PAS renvoyé via le header `Authorization: Bearer`,
  le backend répond 401 et le front redirige vers /login en boucle.

Ces tests vérifient que :
  1. /api/login renvoie bien un token exploitable en mode legacy.
  2. /api/dashboard/summary SANS header => 401 (comportement attendu).
  3. /api/dashboard/summary AVEC `Authorization: Bearer <token>` => 200.
"""

import os
import tempfile
from pathlib import Path


_test_db_dir = tempfile.TemporaryDirectory(prefix='cp-login-flow-')
# Mode legacy : HTTPONLY cookie désactivé (valeur par défaut en dev).
os.environ['CP_ENV'] = 'testing'
os.environ['CP_USE_HTTPONLY_COOKIE'] = 'false'
os.environ['CP_DB_PATH'] = str(Path(_test_db_dir.name) / 'test.db')

import backend  # noqa: E402


def _login(client):
    """Effectue un login legacy et renvoie le token JWT du corps de réponse."""
    response = client.post(
        '/api/login',
        json={'username': backend.ADMIN_USERNAME, 'password': backend.ADMIN_PASSWORD},
    )
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def test_legacy_login_returns_token_in_body():
    backend.create_admin_user()
    client = backend.app.test_client()
    data = _login(client)

    # En mode legacy le token DOIT être dans le corps JSON (pas de cookie).
    assert data['token'], 'Le token doit être renvoyé dans le corps en mode legacy'
    assert 'user_id' in data


def test_dashboard_summary_without_token_is_401():
    client = backend.app.test_client()
    response = client.get('/api/dashboard/summary')
    assert response.status_code == 401


def test_dashboard_summary_with_bearer_token_is_200():
    """Coeur du correctif : le header Bearer débloque le dashboard (fin de boucle)."""
    backend.create_admin_user()
    client = backend.app.test_client()
    token = _login(client)['token']

    response = client.get(
        '/api/dashboard/summary',
        headers={'Authorization': f'Bearer {token}'},
    )
    assert response.status_code == 200, response.get_json()
