#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_logout.py — CP Engineer Pro
================================================================
Test d'intégration de la révocation JWT après logout (CRITICAL-03).

CONTEXTE
--------
backend.py v9.7.0 implémente un mécanisme de révocation JWT via
la table `revoked_tokens` :
  - Au login, chaque JWT reçoit un identifiant unique `jti`.
  - Au logout, ce `jti` est inséré dans `revoked_tokens` avec sa
    date d'expiration.
  - Toute requête ultérieure présentant ce `jti` est rejetée
    avec HTTP 401 "Session révoquée".

SANS CE TEST, il est IMPOSSIBLE de savoir si la révocation
fonctionne réellement : un bug silencieux laisserait un cookie
volé exploitable jusqu'à son expiration naturelle (24 h).

SCÉNARIO TESTÉ (5 étapes)
-------------------------
  1. GET  /api/version      → détection du mode (HttpOnly vs legacy)
  2. POST /api/login        → capture cookie ET/OU token
  3. GET  /api/projects     → vérifie que la session est active (200)
  4. POST /api/logout       → révoque le jti + supprime le cookie
  5. Rejeu de l'ancien jeton/cookie (session fraîche)
                            → DOIT retourner 401 "Session révoquée"

L'étape 5 est LA VÉRIFICATION CRITIQUE : c'est elle qui prouve
que le mécanisme de révocation fonctionne.

USAGE
-----
  # 1. Démarrer le backend dans un terminal :
  #       python backend.py

  # 2. Dans un autre terminal :
  python test_logout.py

  # Avec options :
  python test_logout.py --url http://localhost:5000 \\
                        --username admin \\
                        --password admin123 \\
                        --verbose

  # En production (variables d'environnement) :
  export CP_ADMIN_USERNAME=admin
  export CP_ADMIN_PASSWORD='<mot_de_passe_prod>'
  python test_logout.py --url https://cp.example.com

CODES DE SORTIE
---------------
  0 = tous les tests PASS
  1 = au moins un test FAIL
  2 = erreur d'exécution (serveur inaccessible, credentials
      invalides, rate limiting actif, etc.)

DÉPENDANCES
-----------
  requests (voir requirements-dev.txt)

COMPATIBILITÉ
-------------
  - backend.py 9.7.0 (audit appliqué)
  - Python 3.8+ (f-strings, type hints légers)
  - Linux / macOS / Windows PowerShell

AUCUNE MODIFICATION de backend.py n'est requise pour exécuter
ce test : il n'utilise QUE les endpoints publics existants.
"""

import argparse
import os
import sys
import json
from datetime import datetime

try:
    import requests
except ImportError:
    print("[ERREUR] Le module 'requests' n'est pas installé.")
    print("         Installation : pip install -r requirements-dev.txt")
    print("         Ou plus simple : pip install requests")
    sys.exit(2)


# ============================================================
# CONFIGURATION
# ============================================================

# Nom du cookie posé par backend.py en mode HttpOnly
COOKIE_NAME = 'cp_access_token'

# Endpoints utilisés (aucun autre n'est appelé)
ENDPOINT_VERSION = '/api/version'
ENDPOINT_LOGIN = '/api/login'
ENDPOINT_LOGOUT = '/api/logout'
ENDPOINT_PROJECTS = '/api/projects'

# Timeouts (secondes)
TIMEOUT_SHORT = 5
TIMEOUT_LOGIN = 10

# Substring attendue dans le message d'erreur 401 après révocation
# (comparaison insensible à la casse, tolérante aux accents)
REVOKED_MARKERS = ('revoqu', 'révoqu')

# Configuration de la sortie console pour gérer l'UTF-8 sur Windows
if sys.platform.startswith('win'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass


# ============================================================
# RUNNER DE TEST
# ============================================================
class TestRunner:
    """
    Exécute la séquence de tests en 5 étapes et affiche un
    rapport structuré. Chaque étape renvoie True si elle peut
    continuer, False sinon (arrêt immédiat pour éviter les
    cascades d'erreurs trompeuses).
    """

    def __init__(self, base_url, username, password, verbose=False):
        self.base_url = base_url.rstrip('/')
        self.username = username
        self.password = password
        self.verbose = verbose

        # Session HTTP persistante (gère les cookies automatiquement)
        self.session = requests.Session()

        # Compteurs de résultats
        self.passed = 0
        self.failed = 0

        # État capturé pendant les étapes
        self.http_only_mode = False   # Mode détecté à l'étape 1
        self.legacy_token = None      # Token Bearer (mode legacy)
        self.captured_cookie = None   # Cookie capturé AVANT logout

        # Timestamp de démarrage
        self.started_at = datetime.now()

    # --------------------------------------------------------
    # Helpers d'affichage
    # --------------------------------------------------------
    def _log(self, msg):
        """Affiche un message standard."""
        print(msg)

    def _vlog(self, msg):
        """Affiche un message uniquement en mode verbeux."""
        if self.verbose:
            print("       " + msg)

    def _check(self, name, condition, details=""):
        """
        Vérifie une assertion et met à jour les compteurs.
        Retourne le booléen pour permettre l'enchaînement.
        """
        if condition:
            self.passed += 1
            print(f"  [PASS] {name}")
        else:
            self.failed += 1
            print(f"  [FAIL] {name} {details}")
        return bool(condition)

    def _safe_json(self, response):
        """Parse le JSON d'une réponse, retourne {} en cas d'échec."""
        try:
            return response.json()
        except (ValueError, json.JSONDecodeError):
            return {}

    def _truncate(self, s, n=200):
        """Tronque une chaîne pour affichage (évite les logs géants)."""
        if s is None:
            return ""
        s = str(s)
        return s if len(s) <= n else s[:n] + "..."

    # --------------------------------------------------------
    # Étape 1 : détection du mode d'authentification
    # --------------------------------------------------------
    def step1_detect_mode(self):
        """
        Interroge /api/version pour savoir si le backend tourne en
        mode HttpOnly Cookie ou en mode legacy Bearer.

        C'est ESSENTIEL car les deux modes ne se testent pas de
        la même manière : le rejeu de l'étape 5 diffère.
        """
        print("\n[Étape 1/5] Détection du mode d'authentification...")

        try:
            r = self.session.get(
                f"{self.base_url}{ENDPOINT_VERSION}",
                timeout=TIMEOUT_SHORT
            )
        except requests.exceptions.ConnectionError as e:
            self._log(f"  [ERREUR] Connexion impossible au backend : {e}")
            self._log(f"           Vérifiez que le backend tourne sur {self.base_url}")
            return False
        except requests.exceptions.Timeout:
            self._log(f"  [ERREUR] Timeout sur {ENDPOINT_VERSION}")
            return False
        except requests.exceptions.RequestException as e:
            self._log(f"  [ERREUR] Requête échouée : {e}")
            return False

        if not self._check(
            "GET /api/version retourne 200",
            r.status_code == 200,
            f"(reçu : {r.status_code})"
        ):
            return False

        data = self._safe_json(r)
        if not data:
            self._log("  [ERREUR] Réponse non-JSON ou JSON invalide")
            return False

        # Lecture des champs exposés par backend.py
        self.http_only_mode = bool(data.get('useHttpOnlyCookie', False))
        environment = data.get('environment', '?')
        backend_version = data.get('version', '?')
        api_version = data.get('apiVersion', '?')
        cookie_secure = data.get('cookieSecure', '?')

        self._log(f"  Mode HttpOnly Cookie : {self.http_only_mode}")
        self._log(f"  Environnement        : {environment}")
        self._log(f"  Version backend      : {backend_version}")
        self._log(f"  Version API          : {api_version}")
        self._log(f"  Cookie Secure        : {cookie_secure}")

        # Note : en mode HttpOnly, le cookie DOIT être Secure en
        # production. On affiche un avertissement informatif.
        if self.http_only_mode and cookie_secure is False and environment == 'production':
            self._log("  [AVERTISSEMENT] Mode HttpOnly en production sans Secure=true")
            self._log("                  → définir CP_COOKIE_SECURE=true")

        return True

    # --------------------------------------------------------
    # Étape 2 : authentification
    # --------------------------------------------------------
    def step2_login(self):
        """
        Authentifie l'utilisateur et capture :
          - le cookie cp_access_token (mode HttpOnly)
          - OU le token JWT (mode legacy)
        """
        print("\n[Étape 2/5] Authentification...")

        payload = {"username": self.username, "password": self.password}

        try:
            r = self.session.post(
                f"{self.base_url}{ENDPOINT_LOGIN}",
                json=payload,
                timeout=TIMEOUT_LOGIN
            )
        except requests.exceptions.RequestException as e:
            self._log(f"  [ERREUR] Requête login échouée : {e}")
            return False

        # Cas particulier : rate limiting
        if r.status_code == 429:
            self._log("  [ERREUR] Rate limiting actif (HTTP 429).")
            self._log("           Attendez 5 minutes ou redémarrez le backend en dev.")
            return False

        # Cas particulier : mauvais identifiants
        if r.status_code == 401:
            body = self._safe_json(r)
            err = body.get('error', 'Identifiants invalides')
            self._log(f"  [ERREUR] Authentification refusée : {err}")
            self._log(f"           Utilisateur testé : {self.username!r}")
            self._log(f"           (En dev : admin/admin123 si bind localhost)")
            return False

        if not self._check(
            "POST /api/login retourne 200",
            r.status_code == 200,
            f"(reçu : {r.status_code} — {self._truncate(r.text)})"
        ):
            return False

        data = self._safe_json(r)
        if not data:
            self._log("  [ERREUR] Réponse login non-JSON")
            return False

        if self.http_only_mode:
            # ─── Mode HttpOnly : le cookie porte le JWT ───
            cookie = self.session.cookies.get(COOKIE_NAME)

            self._check(
                f"Cookie '{COOKIE_NAME}' présent",
                cookie is not None and len(cookie) > 0,
                f"(cookie : {self._truncate(cookie, 40)})"
            )

            self._check(
                "Réponse JSON sans champ 'token' (sécurité)",
                data.get('token') is None,
                f"(token reçu : {self._truncate(data.get('token'), 40)})"
            )

            self._check(
                "Champ 'csrf_token' présent",
                data.get('csrf_token') is not None
            )

            self._check(
                "Champ 'user_id' présent",
                data.get('user_id') is not None
            )

            self._check(
                "Champ 'role' présent",
                data.get('role') is not None
            )

            # ⭐ CAPTURE DU COOKIE **AVANT** LOGOUT
            #    C'est ce cookie qu'on rejouera à l'étape 5 pour
            #    vérifier que la révocation fonctionne.
            self.captured_cookie = cookie
            self._vlog(f"Cookie capturé pour rejeu : {self._truncate(cookie, 60)}")

        else:
            # ─── Mode legacy : JWT dans le corps JSON ───
            self.legacy_token = data.get('token')

            self._check(
                "Champ 'token' présent dans la réponse",
                self.legacy_token is not None and len(self.legacy_token) > 0,
                f"(token : {self._truncate(self.legacy_token, 40)})"
            )

            if self.legacy_token:
                # Ajoute le header Authorization pour les requêtes suivantes
                self.session.headers.update({
                    'Authorization': f'Bearer {self.legacy_token}'
                })
                self._vlog(f"Header Authorization positionné (Bearer ...)")

            self._check(
                "Champ 'user_id' présent",
                data.get('user_id') is not None
            )

            self._check(
                "Champ 'role' présent",
                data.get('role') is not None
            )

        return True

    # --------------------------------------------------------
    # Étape 3 : vérification que la session est active
    # --------------------------------------------------------
    def step3_verify_authenticated(self):
        """
        Confirme que le cookie/token permet bien d'accéder à une
        ressource protégée AVANT le logout.
        """
        print("\n[Étape 3/5] Vérification session active...")

        try:
            r = self.session.get(
                f"{self.base_url}{ENDPOINT_PROJECTS}",
                timeout=TIMEOUT_SHORT
            )
        except requests.exceptions.RequestException as e:
            self._log(f"  [ERREUR] Requête échouée : {e}")
            return False

        self._check(
            "GET /api/projects retourne 200 (session active)",
            r.status_code == 200,
            f"(reçu : {r.status_code})"
        )

        if r.status_code == 200:
            body = self._safe_json(r)
            total = body.get('total')
            if total is not None:
                self._vlog(f"Nombre de projets visibles : {total}")

        return r.status_code == 200

    # --------------------------------------------------------
    # Étape 4 : logout
    # --------------------------------------------------------
    def step4_logout(self):
        """
        Déclenche le logout. Le backend doit :
          - insérer le jti dans revoked_tokens
          - supprimer le cookie HttpOnly (mode HttpOnly)
        """
        print("\n[Étape 4/5] Déconnexion (POST /api/logout)...")

        try:
            r = self.session.post(
                f"{self.base_url}{ENDPOINT_LOGOUT}",
                timeout=TIMEOUT_SHORT
            )
        except requests.exceptions.RequestException as e:
            self._log(f"  [ERREUR] Requête logout échouée : {e}")
            return False

        self._check(
            "POST /api/logout retourne 200",
            r.status_code == 200,
            f"(reçu : {r.status_code} — {self._truncate(r.text)})"
        )

        if r.status_code != 200:
            return False

        body = self._safe_json(r)
        self._check(
            "Réponse logout : {'success': true}",
            body.get('success') is True
        )

        if self.http_only_mode:
            cookie_after = self.session.cookies.get(COOKIE_NAME)
            self._check(
                f"Cookie '{COOKIE_NAME}' supprimé côté client",
                cookie_after is None or len(cookie_after) == 0,
                f"(cookie résiduel : {self._truncate(cookie_after, 40)})"
            )

        return True

    # --------------------------------------------------------
    # Étape 5 : rejeu de l'ancien jeton (TEST CRITIQUE)
    # --------------------------------------------------------
    def step5_replay_revoked(self):
        """
        ⭐ VÉRIFICATION CRITIQUE (CRITICAL-03)

        Rejoue le jeton/cookie capturé AVANT le logout, dans une
        session HTTP **fraîche** qui n'a AUCUN cookie résiduel et
        AUCUN header Authorization automatique.

        Comportement attendu :
          - HTTP 401
          - Message contenant "révoquée"

        Si le test retourne 200, alors la révocation est CASSÉE
        et un cookie volé reste exploitable jusqu'à expiration.
        """
        print("\n[Étape 5/5] Rejeu de l'ancien jeton (CRITICAL-03)...")

        if self.http_only_mode:
            if not self.captured_cookie:
                self._log("  [SKIP] Aucun cookie capturé à l'étape 2")
                return

            self._vlog(f"Rejeu du cookie : {self._truncate(self.captured_cookie, 60)}")

            # Requête HTTP BRUTE avec le cookie volé
            # (pas via self.session, qui a déjà supprimé le cookie)
            try:
                r = requests.get(
                    f"{self.base_url}{ENDPOINT_PROJECTS}",
                    cookies={COOKIE_NAME: self.captured_cookie},
                    timeout=TIMEOUT_SHORT
                )
            except requests.exceptions.RequestException as e:
                self._log(f"  [ERREUR] Requête de rejeu échouée : {e}")
                return

            self._check(
                "GET /api/projects avec cookie révoqué retourne 401",
                r.status_code == 401,
                f"(reçu : {r.status_code})"
            )

            if r.status_code == 200:
                self._log("  ⚠️  ALERTE CRITIQUE : le cookie révoqué est TOUJOURS VALIDE !")
                self._log("     → Le mécanisme CRITICAL-03 ne fonctionne PAS.")
                self._log("     → Vérifier la table revoked_tokens et la fonction logout().")
            elif r.status_code == 401:
                body = self._safe_json(r)
                err = str(body.get('error', '')).lower()
                self._check(
                    "Message d'erreur = 'Session révoquée'",
                    any(m in err for m in REVOKED_MARKERS),
                    f"(message : {body.get('error')!r})"
                )

        else:
            if not self.legacy_token:
                self._log("  [SKIP] Aucun token legacy capturé à l'étape 2")
                return

            self._vlog(f"Rejeu du token : {self._truncate(self.legacy_token, 60)}")

            # Requête HTTP BRUTE avec le token volé
            try:
                r = requests.get(
                    f"{self.base_url}{ENDPOINT_PROJECTS}",
                    headers={'Authorization': f'Bearer {self.legacy_token}'},
                    timeout=TIMEOUT_SHORT
                )
            except requests.exceptions.RequestException as e:
                self._log(f"  [ERREUR] Requête de rejeu échouée : {e}")
                return

            self._check(
                "GET /api/projects avec token révoqué retourne 401",
                r.status_code == 401,
                f"(reçu : {r.status_code})"
            )

            if r.status_code == 200:
                self._log("  ⚠️  ALERTE CRITIQUE : le token révoqué est TOUJOURS VALIDE !")
                self._log("     → Le mécanisme CRITICAL-03 ne fonctionne PAS.")
            elif r.status_code == 401:
                body = self._safe_json(r)
                err = str(body.get('error', '')).lower()
                self._check(
                    "Message d'erreur = 'Session révoquée'",
                    any(m in err for m in REVOKED_MARKERS),
                    f"(message : {body.get('error')!r})"
                )

    # --------------------------------------------------------
    # Nettoyage final
    # --------------------------------------------------------
    def _cleanup(self):
        """
        Ferme la session HTTP proprement (libère les connexions).
        Aucun effet sur le backend.
        """
        try:
            self.session.close()
        except Exception:
            pass

    # --------------------------------------------------------
    # Exécution complète
    # --------------------------------------------------------
    def run(self):
        """
        Orchestre les 5 étapes. Retourne le code de sortie :
          0 = tous les tests PASS
          1 = au moins un test FAIL
          2 = erreur d'exécution
        """
        print("=" * 70)
        print("  TEST CRITICAL-03 : Révocation JWT après logout")
        print("=" * 70)
        print(f"  Cible     : {self.base_url}")
        print(f"  Utilisateur : {self.username}")
        print(f"  Démarré   : {self.started_at.strftime('%Y-%m-%d %H:%M:%S')}")
        print("=" * 70)

        # Étape 1 : mode
        if not self.step1_detect_mode():
            self._cleanup()
            return 2

        # Étape 2 : login
        if not self.step2_login():
            self._cleanup()
            return 2

        # Étape 3 : session active
        if not self.step3_verify_authenticated():
            self._cleanup()
            return 1

        # Étape 4 : logout
        if not self.step4_logout():
            self._cleanup()
            return 1

        # Étape 5 : rejeu (test critique)
        self.step5_replay_revoked()

        # Résumé
        elapsed = (datetime.now() - self.started_at).total_seconds()
        print("\n" + "=" * 70)
        if self.failed == 0:
            status = "TOUS LES TESTS PASS ✅"
        else:
            status = "ÉCHEC ❌"
        print(f"  RÉSULTAT : {self.passed} PASS / {self.failed} FAIL — {status}")
        print(f"  Durée    : {elapsed:.2f} s")
        print("=" * 70)

        self._cleanup()
        return 0 if self.failed == 0 else 1


# ============================================================
# POINT D'ENTRÉE
# ============================================================
def main():
    parser = argparse.ArgumentParser(
        description=(
            "Test de la révocation JWT (CRITICAL-03) sur le backend "
            "CP Engineer Pro."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Exemples :\n"
            "  python test_logout.py\n"
            "  python test_logout.py --url http://localhost:5000\n"
            "  python test_logout.py --username admin --password admin123\n"
            "  python test_logout.py --url https://cp.example.com --verbose\n"
        )
    )

    parser.add_argument(
        '--url',
        default='http://localhost:5000',
        help='URL de base du backend (défaut : http://localhost:5000)'
    )
    parser.add_argument(
        '--username',
        default=None,
        help=(
            "Nom d'utilisateur (défaut : CP_ADMIN_USERNAME ou 'admin')"
        )
    )
    parser.add_argument(
        '--password',
        default=None,
        help=(
            "Mot de passe (défaut : CP_ADMIN_PASSWORD ou 'admin123' "
            "en mode dev)"
        )
    )
    parser.add_argument(
        '-v', '--verbose',
        action='store_true',
        help='Mode verbeux (affiche les cookies/tokens tronqués)'
    )

    args = parser.parse_args()

    # Priorité : argument CLI > variable d'environnement > défaut dev
    username = args.username or os.environ.get('CP_ADMIN_USERNAME', 'admin')
    password = args.password or os.environ.get('CP_ADMIN_PASSWORD', 'admin123')

    runner = TestRunner(
        base_url=args.url,
        username=username,
        password=password,
        verbose=args.verbose
    )

    try:
        exit_code = runner.run()
    except KeyboardInterrupt:
        print("\n\n[INTERROMPU] Test annulé par l'utilisateur.")
        exit_code = 2
    except Exception as e:
        print(f"\n[ERREUR INATTENDUE] {type(e).__name__} : {e}")
        exit_code = 2

    sys.exit(exit_code)


if __name__ == '__main__':
    main()