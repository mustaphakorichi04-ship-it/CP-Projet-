// ============================================================
// storage-proxy.js – CP Engineer Pro – Couche de persistance proxy
// Module proxy. Version applicative : APP_CONFIG.VERSION (engine.js).
//
// Corrections appliquées :
//   P1-04 : Mécanisme anti-récursion explicite et robuste
//     - Compteur de profondeur _saveDepth à isolation stricte
//     - Token unique _saveToken par opération de sauvegarde
//     - Champ _fromSave propagé de manière uniforme
//     - try/finally garanti sur toutes les opérations critiques
//     - Event listeners vérifient systématiquement les deux
//       conditions : _fromSave === true OU isInternalSave() === true
//     - Émissions dataSynced centralisées via _emitDataSynced()
//
//   V04 (AUDIT SÉCURITÉ) : Support HttpOnly Cookie
//     - USE_HTTPONLY_COOKIE : bascule vers cookie HttpOnly (Secure,
//       SameSite=Strict) pour éliminer l'exposition du JWT au XSS
//     - Ajout du support CSRF (X-CSRF-Token) pour les méthodes mutantes
//     - fetchWithAuth() envoie credentials:'include' si cookie mode
//     - login() récupère et stocke le csrf_token si fourni par backend
//     - getToken() retourne une sentinelle 'cookie' en mode HttpOnly
//     - Rétrocompatibilité : si USE_HTTPONLY_COOKIE=false, comportement
//       legacy localStorage préservé
//
//   ⭐ CRITICAL-01 (POST-AUDIT) : Source de vérité unique pour HttpOnly
//     - USE_HTTPONLY_COOKIE n'est plus codé en dur à 'true'
//     - Lecture au démarrage depuis /api/version (SSOT backend)
//     - _initHttpOnlyMode() : résolution asynchrone unique
//     - ensureHttpOnlyModeReady() : promesse partagée, évite les
//       races conditions entre init et login/logout
//     - login() et logout() attendent la résolution du mode
//     - Fallback prudent 'false' (mode legacy) en cas d'échec réseau
//
//   ⭐ BUG-CP-PROXY-401 (CORRECTION RÉCENTE) : checkBackend() utilise
//     désormais /api/version (endpoint PUBLIC) au lieu de /api/projects
//     (endpoint PROTÉGÉ par @token_required dans backend.py).
//     → Élimine les erreurs 401 UNAUTHORIZED en boucle dans la console.
//     → Le mode hors ligne reste fonctionnel si le serveur est réellement
//       injoignable (timeout, 5xx, erreur réseau).
// ============================================================

(function() {
    'use strict';

    // ============================================================
    // 1. CONFIGURATION
    // ============================================================
    // FIX CSP : URL relative au lieu d'absolue.
    // ------------------------------------------------------------
    // "http://localhost:5000" et "http://127.0.0.1:5000" sont
    // deux ORIGINES DIFFÉRENTES pour le navigateur. Le CSP du
    // backend autorise 'self' (l'origine de la page), mais bloquait
    // l'origine "localhost" quand la page était servie depuis
    // "127.0.0.1". Une URL relative /api utilise automatiquement
    // l'origine de la page → conforme CSP natif.
    // ------------------------------------------------------------
    const API_BASE_URL = '/api';
    const IS_FILE_CONTEXT = window.location.protocol === 'file:';
    let _isBackendAvailable = !IS_FILE_CONTEXT;
    let _pendingSync = false;
    let _retryQueue = [];
    let _isProcessingRetry = false;
    let _syncInProgress = false;

    // OPTIM : Cache des requêtes en vol pour éviter les doublons
    const _inFlightRequests = new Map();

    // OPTIM : Cache des résultats GET
    const _responseCache = new Map();
    const CACHE_TTL = 60000; // 1 minute

    // ============================================================
    // 1.0 CORRECTIF BOUCLE INFINIE : Mécanisme anti-récursion robuste
    // ============================================================
    /**
     * Profondeur d'imbrication des sauvegardes internes.
     * Chaque opération de sauvegarde incrémente ce compteur dans son entrée
     * et le décrémente dans son finally. Toute opération qui se déclenche
     * alors que _saveDepth > 0 est considérée comme récursive.
     */
    let _saveDepth = 0;

    /**
     * Token unique identifiant la sauvegarde courante.
     * Propagé dans le detail de chaque dataSynced émis par cette sauvegarde.
     */
    let _currentSaveToken = null;

    /**
     * Compteur monotone pour générer des tokens uniques.
     */
    let _saveTokenCounter = 0;

    /**
     * Démarre une sauvegarde interne.
     * @returns {string} Le token associé à cette sauvegarde
     */
    function beginInternalSave() {
        _saveDepth++;
        _saveTokenCounter++;
        _currentSaveToken = 'save_' + Date.now() + '_' + _saveTokenCounter;
        return _currentSaveToken;
    }

    /**
     * Termine une sauvegarde interne.
     */
    function endInternalSave() {
        _saveDepth = Math.max(0, _saveDepth - 1);
        if (_saveDepth === 0) {
            _currentSaveToken = null;
        }
    }

    /**
     * Indique si une sauvegarde interne est en cours.
     * @returns {boolean}
     */
    function isInternalSave() {
        return _saveDepth > 0;
    }

    /**
     * Émet un événement dataSynced en le marquant systématiquement
     * comme provenant d'une sauvegarde interne.
     *
     * ⚠️ Cette fonction est la SEULE voie autorisée pour émettre dataSynced
     * depuis storage-proxy.js. Toute nouvelle émission doit passer par ici.
     *
     * @param {Object} detail - Détails supplémentaires (type, id, count...)
     */
    function _emitDataSynced(detail) {
        const enrichedDetail = Object.assign({}, detail || {}, {
            timestamp: Date.now(),
            _fromSave: true,
            _saveToken: _currentSaveToken
        });
        try {
            document.dispatchEvent(new CustomEvent('dataSynced', {
                detail: enrichedDetail
            }));
        } catch (e) {
            console.warn('[Proxy] Erreur émission dataSynced:', e);
        }
    }

    // ============================================================
    // 1.1 GESTION DU TOKEN JWT — V04 + CRITICAL-01
    // ============================================================
    /**
     * V04 + CRITICAL-01 : Mode HttpOnly Cookie.
     *
     * Lorsque cette variable est true :
     *   - Le JWT n'est JAMAIS stocké dans localStorage (immune au XSS)
     *   - Le backend pose un cookie HttpOnly + Secure + SameSite=Strict
     *   - Les requêtes envoient automatiquement le cookie (credentials:'include')
     *   - Un token CSRF est requis pour les méthodes mutantes (POST/PUT/PATCH/DELETE)
     *
     * CRITICAL-01 : cette valeur n'est PLUS codée en dur. Elle est lue au
     * démarrage depuis /api/version (source de vérité unique côté backend).
     * Le fallback 'false' est volontairement prudent : en cas d'échec de
     * lecture, on retombe sur le mode legacy (JWT en localStorage), qui
     * fonctionne avec un backend dont CP_USE_HTTPONLY_COOKIE=false.
     *
     * ⚠️ Pour basculer en mode sécurisé, définir côté backend :
     *    CP_USE_HTTPONLY_COOKIE=true
     *
     * La résolution asynchrone est déclenchée par ensureHttpOnlyModeReady(),
     * appelée automatiquement par login() et logout().
     */
    let USE_HTTPONLY_COOKIE = false;

    /**
     * CRITICAL-01 : interroge /api/version pour récupérer le mode
     * réellement configuré côté backend. Appelé au démarrage, AVANT
     * toute tentative d'authentification.
     *
     * @returns {Promise<boolean>} true si mode HttpOnly actif
     */
    async function _initHttpOnlyMode() {
        if (IS_FILE_CONTEXT) return false;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            const response = await fetch(`${API_BASE_URL}/version`, {
                method: 'GET',
                credentials: 'same-origin',
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!response.ok) {
                console.warn('[Proxy] /api/version indisponible (HTTP ' + response.status + '), fallback mode legacy.');
                return false;
            }
            const data = await response.json();
            if (data && typeof data.useHttpOnlyCookie === 'boolean') {
                USE_HTTPONLY_COOKIE = data.useHttpOnlyCookie;
                console.log('[Proxy] Mode HttpOnly lu depuis backend:',
                            USE_HTTPONLY_COOKIE);
                if (USE_HTTPONLY_COOKIE) {
                    console.log('[Proxy] 🔒 Mode HttpOnly Cookie ACTIF (JWT non exposé au JS).');
                } else {
                    console.log('[Proxy] ⚠️  Mode legacy localStorage. ' +
                                'Activez CP_USE_HTTPONLY_COOKIE=true côté backend.');
                }
            }
            return USE_HTTPONLY_COOKIE;
        } catch (e) {
            console.warn('[Proxy] Échec lecture mode HttpOnly, fallback legacy:', e.message);
            return false;
        }
    }

    /**
     * CRITICAL-01 : promesse unique partagée par login() et logout()
     * pour garantir que le mode HttpOnly est résolu avant toute
     * opération d'authentification.
     */
    let _httpOnlyInitPromise = null;

    function ensureHttpOnlyModeReady() {
        if (!_httpOnlyInitPromise) {
            _httpOnlyInitPromise = _initHttpOnlyMode();
        }
        return _httpOnlyInitPromise;
    }

    /**
     * V04 : Mémoire volatile du token CSRF (en mode HttpOnly).
     * Le token CSRF n'est PAS secret au sens XSS (le JS peut le lire),
     * mais il empêche les attaques CSRF cross-origin.
     */
    let _csrfToken = null;

    /**
     * Mémoire volatile des métadonnées utilisateur.
     * (en mode HttpOnly, ces infos ne peuvent pas être dérivées du token)
     */
    let _userId = null;
    let _userRole = null;

    // Legacy : token JWT en mémoire (mode non-HttpOnly uniquement)
    let _authToken = null;
    let _tokenExpiry = null;

    /**
     * V04 : Retourne le token d'authentification.
     *
     * En mode HttpOnly : retourne la sentinelle 'cookie'.
     *   → fetchWithAuth() n'ajoute PAS de header Authorization.
     *   → Le cookie est envoyé automatiquement par le navigateur.
     *
     * En mode legacy : retourne le JWT depuis localStorage ou mémoire.
     *
     * @returns {string|null}
     */
    function getToken() {
        // ─── Mode HttpOnly : cookie géré par le navigateur ───
        if (USE_HTTPONLY_COOKIE) {
            // Sentinelle : indique qu'une session est peut-être active.
            // Le backend validera le cookie lui-même.
            return 'cookie';
        }

        // ─── Mode legacy : localStorage ───
        if (_authToken) return _authToken;
        try {
            const stored = localStorage.getItem('cp_auth_token');
            if (stored) {
                const data = JSON.parse(stored);
                if (data.token && data.expiry && Date.now() < data.expiry) {
                    _authToken = data.token;
                    _tokenExpiry = data.expiry;
                    _userId = data.userId || null;
                    _userRole = data.role || 'viewer';
                    return _authToken;
                }
                localStorage.removeItem('cp_auth_token');
            }
        } catch (e) {
            console.warn('[Proxy] Erreur lecture token:', e);
        }
        return null;
    }

    /**
     * V04 : Enregistre les informations d'authentification après login.
     *
     * En mode HttpOnly : stocke UNIQUEMENT le CSRF token + userId/role.
     *   → Le JWT est déjà posé par le backend via Set-Cookie.
     *
     * En mode legacy : stocke le JWT dans localStorage.
     *
     * @param {string|null} token    - JWT (null en mode HttpOnly)
     * @param {string} userId
     * @param {string} role
     * @param {number} [expiresIn=86400] - Secondes
     * @param {string|null} [csrfToken=null]
     */
    function setToken(token, userId, role, expiresIn = 86400, csrfToken = null) {
        _userId = userId || null;
        _userRole = role || 'viewer';

        // ─── V04 : CSRF token (mode HttpOnly) ───
        if (csrfToken) {
            _csrfToken = csrfToken;
        }

        // ─── Mode HttpOnly : RIEN dans localStorage ───
        if (USE_HTTPONLY_COOKIE) {
            // Le JWT est un cookie HttpOnly posé par le backend.
            // On ne stocke AUCUN secret en JS.
            _authToken = null;
            _tokenExpiry = null;
            console.log('[Proxy] Session HttpOnly active (token non exposé au JS).');
            if (_isBackendAvailable) {
                setTimeout(() => syncPendingChanges(), 1000);
            }
            return;
        }

        // ─── Mode legacy : localStorage ───
        _authToken = token || null;
        _tokenExpiry = token ? (Date.now() + expiresIn * 1000) : null;

        try {
            if (token) {
                localStorage.setItem('cp_auth_token', JSON.stringify({
                    token: token,
                    expiry: _tokenExpiry,
                    userId: _userId,
                    role: _userRole
                }));
            }
            if (window.location.hostname !== 'localhost' &&
                window.location.hostname !== '127.0.0.1') {
                console.warn('[Proxy] ⚠️ Le JWT est stocké dans localStorage. ' +
                             'Activez CP_USE_HTTPONLY_COOKIE=true côté backend ' +
                             'pour éliminer cette vulnérabilité XSS.');
            }
        } catch (e) {
            console.warn('[Proxy] Erreur sauvegarde token:', e);
        }

        if (_isBackendAvailable) {
            setTimeout(() => syncPendingChanges(), 1000);
        }
    }

    /**
     * V04 : Définit le token CSRF seul (utile après refresh de session).
     */
    function setCsrfToken(token) {
        _csrfToken = token || null;
    }

    /**
     * V04 : Retourne le token CSRF courant.
     */
    function getCsrfToken() {
        return _csrfToken;
    }

    /**
     * Efface toutes les données d'authentification.
     */
    function clearToken() {
        _authToken = null;
        _tokenExpiry = null;
        _userId = null;
        _userRole = null;
        _csrfToken = null;

        try {
            localStorage.removeItem('cp_auth_token');
        } catch (e) {}

        document.dispatchEvent(new CustomEvent('authLoggedOut'));
    }

    function isAuthenticated() {
        // En mode HttpOnly, on ne peut pas savoir sans interroger le serveur.
        // On considère qu'une session existe si _userId est présent (post-login).
        if (USE_HTTPONLY_COOKIE) {
            return _userId !== null;
        }
        return getToken() !== null;
    }

    function getUserId() {
        return _userId || null;
    }

    function getUserRole() {
        return _userRole || 'viewer';
    }

    // ============================================================
    // 1.2 REQUÊTE AVEC AUTH ET CACHE
    // ============================================================
    /**
     * V04 : Requête authentifiée compatible HttpOnly Cookie + CSRF.
     *
     * En mode HttpOnly :
     *   - credentials:'include' → le cookie est envoyé automatiquement
     *   - Header X-CSRF-Token ajouté sur POST/PUT/PATCH/DELETE
     *   - AUCUN header Authorization (le cookie le remplace)
     *
     * En mode legacy :
     *   - Header Authorization: Bearer <jwt>
     */
    function fetchWithAuth(url, options = {}) {
        if (IS_FILE_CONTEXT) {
            return Promise.reject(new Error('Backend desactive en contexte file://'));
        }
        const headers = Object.assign({}, options.headers || {});
        const method = (options.method || 'GET').toUpperCase();

        if (USE_HTTPONLY_COOKIE) {
            if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
                if (_csrfToken) {
                    headers['X-CSRF-Token'] = _csrfToken;
                }
            }
        } else {
            const token = getToken();
            if (token) {
                headers['Authorization'] = 'Bearer ' + token;
            }
        }

        if (options.body && typeof options.body === 'object' && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }

        return fetch(url, {
            ...options,
            credentials: USE_HTTPONLY_COOKIE ? 'include' : 'same-origin',
            headers: headers
        }).then(response => {
            if (response.status === 401) {
                // ─────────────────────────────────────────────────────
                // FIX 401 : dédoublonnage pour éviter les toasts répétés
                // et la cascade de logs quand plusieurs requêtes
                // parallèles échouent simultanément (ex : 3 équipements
                // en sync + 1 PUT projet au même instant).
                // ─────────────────────────────────────────────────────
                const now = Date.now();
                const lastSignal = window._cpLastAuthExpiredSignal || 0;
                const shouldNotify = (now - lastSignal) > 3000; // 3 s

                if (shouldNotify) {
                    window._cpLastAuthExpiredSignal = now;
                    console.warn('[Proxy] Session expirée ou invalide, déconnexion.');
                    clearToken();

                    // Marquer le backend comme indisponible temporairement
                    // pour éviter la boucle de sync immédiate.
                    _isBackendAvailable = false;

                    if (window.UI && typeof window.UI.showToast === 'function') {
                        window.UI.showToast(
                            '⚠️ Session expirée. Veuillez vous reconnecter.',
                            'warning'
                        );
                    }
                    document.dispatchEvent(new CustomEvent('authSessionExpired'));
                }
            }
            return response;
        });
    }

    async function fetchWithCache(url, options = {}, cacheKey) {
        const key = cacheKey || url + (options.method || 'GET') +
                    (options.body ? JSON.stringify(options.body) : '');

        if (!options.method || options.method === 'GET') {
            const cached = _responseCache.get(key);
            if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
                return cached.response.clone();
            }
        }

        if (_inFlightRequests.has(key)) {
            return _inFlightRequests.get(key);
        }

        const promise = fetchWithAuth(url, options)
            .then(response => {
                if (!options.method || options.method === 'GET') {
                    _responseCache.set(key, {
                        response: response.clone(),
                        timestamp: Date.now()
                    });
                }
                _inFlightRequests.delete(key);
                return response;
            })
            .catch(error => {
                _inFlightRequests.delete(key);
                throw error;
            });

        _inFlightRequests.set(key, promise);
        return promise;
    }

    // ============================================================
    // 1.3 LOGIN / LOGOUT
    // ============================================================
    /**
     * V04 + CRITICAL-01 : Login compatible HttpOnly Cookie.
     *
     * En mode HttpOnly :
     *   - Le backend pose le cookie via Set-Cookie
     *   - Le backend renvoie { user_id, role, csrf_token } (PAS de token)
     *   - On stocke uniquement csrf_token + userId + role
     *
     * En mode legacy :
     *   - Le backend renvoie { token, user_id, role }
     *   - On stocke le JWT dans localStorage
     *
     * CRITICAL-01 : attend la résolution du mode HttpOnly
     * (lecture /api/version) avant de contacter /api/login, pour
     * garantir que credentials et CSRF sont correctement configurés.
     */
    let login = async function(username, password) {
        // ⭐ CRITICAL-01 : attendre que le mode HttpOnly soit résolu
        //    depuis /api/version avant de tenter l'authentification.
        await ensureHttpOnlyModeReady();

        try {
            const response = await fetch(`${API_BASE_URL}/login`, {
                method: 'POST',
                credentials: USE_HTTPONLY_COOKIE ? 'include' : 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            if (!response.ok) {
                let errorMsg = 'Échec de l\'authentification';
                try {
                    const error = await response.json();
                    errorMsg = error.error || errorMsg;
                } catch (e) {}
                throw new Error(errorMsg);
            }
            const data = await response.json();

            // ─── V04 : Enregistrement selon le mode ───
            if (USE_HTTPONLY_COOKIE) {
                setToken(
                    null,                      // pas de token exposé
                    data.user_id,
                    data.role,
                    86400,
                    data.csrf_token || null    // CSRF pour méthodes mutantes
                );
            } else {
                setToken(data.token, data.user_id, data.role);
            }

            // ⭐ PULL-BOOTSTRAP : après authentification, tirer les
            // projets/équipements du serveur vers le stockage local
            // (rend les données visibles même sur un navigateur vierge).
            setTimeout(() => {
                pullProjectsFromBackend({ silent: false }).catch(e =>
                    console.warn('[Proxy] Pull après login:', e));
            }, 1200);

            console.log('[Proxy] Authentification réussie pour', username);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast(`✅ Connecté en tant que ${username}`, 'success');
            }
            _responseCache.clear();
            return data;
        } catch (error) {
            console.error('[Proxy] Erreur de login:', error);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast(`❌ Erreur de connexion: ${error.message}`, 'error');
            }
            throw error;
        }
    };

    /**
     * V04 + CRITICAL-03 + CRITICAL-01 : Logout.
     *
     * Notifie le backend pour :
     *   - invalider le cookie HttpOnly côté serveur
     *   - révoquer le jti du JWT (CRITICAL-03, table revoked_tokens)
     *
     * CRITICAL-01 : attend la résolution du mode HttpOnly pour
     * envoyer la requête dans le bon mode (cookie vs header).
     */
    let logout = async function() {
        // ⭐ CRITICAL-01 : attendre que le mode HttpOnly soit résolu
        await ensureHttpOnlyModeReady();

        // Notifier le backend (invalide le cookie côté serveur
        // ET révoque le jti via /api/logout → CRITICAL-03 côté backend).
        try {
            await fetchWithAuth(`${API_BASE_URL}/logout`, { method: 'POST' });
        } catch (e) {
            // Silencieux : le nettoyage local est prioritaire
        }
        clearToken();
        _responseCache.clear();
        _inFlightRequests.clear();
        if (window.UI && typeof window.UI.showToast === 'function') {
            window.UI.showToast('🔓 Déconnecté', 'info');
        }
        document.dispatchEvent(new CustomEvent('authLoggedOut'));
    };

    // ============================================================
    // 2. CONFIGURATION DES RETRIES
    // ============================================================
    const RETRY_CONFIG = {
        maxAttempts: 3,
        baseDelay: 1000,
        maxDelay: 8000,
        backoffFactor: 2
    };

    let _lastSyncData = null;
    let _lastSyncTimestamp = 0;
    const _projectVersions = new Map();
    try {
        const savedVersions = JSON.parse(localStorage.getItem('cp_project_versions') || '{}');
        for (const [projectId, version] of Object.entries(savedVersions)) {
            if (Number.isInteger(version) && version >= 1) _projectVersions.set(projectId, version);
        }
    } catch (e) {}
    let _conflictedProjects = new Set();
    try {
        _conflictedProjects = new Set(JSON.parse(localStorage.getItem('cp_sync_conflicts') || '[]'));
    } catch (e) {
        _conflictedProjects = new Set();
    }

    function withProjectVersion(projectId, options = {}) {
        const headers = Object.assign({}, options.headers || {});
        const version = _projectVersions.get(projectId);
        if (version !== undefined) headers['If-Match'] = String(version);
        return { ...options, headers };
    }

    function rememberProjectVersionValue(projectId, version) {
        if (!Number.isInteger(version) || version < 1) return;
        _projectVersions.set(projectId, version);
        try {
            localStorage.setItem('cp_project_versions', JSON.stringify(Object.fromEntries(_projectVersions)));
        } catch (e) {}
    }

    async function rememberProjectVersion(response, projectId) {
        try {
            const data = await response.clone().json();
            if (Number.isInteger(data.projectVersion)) rememberProjectVersionValue(projectId, data.projectVersion);
            else if (Number.isInteger(data.version)) rememberProjectVersionValue(projectId, data.version);
        } catch (e) {}
    }

    function isProjectVersionFailure(response) {
        return response.status === 409 || response.status === 428;
    }

    async function recordProjectConflict(response, projectId) {
        let details = {};
        try { details = await response.clone().json(); } catch (e) {}
        _conflictedProjects.add(projectId);
        try { localStorage.setItem('cp_sync_conflicts', JSON.stringify([..._conflictedProjects])); } catch (e) {}
        const message = `Conflit de synchronisation pour ${projectId}: les données locales sont conservées et la synchronisation automatique est suspendue. Exportez une sauvegarde avant toute résolution.`;
        console.error('[Proxy]', message, details);
        if (window.UI && typeof window.UI.showToast === 'function') window.UI.showToast(message, 'error');
        document.dispatchEvent(new CustomEvent('projectSyncConflict', { detail: { projectId, ...details } }));
    }

    function getRetryDelay(attempt) {
        const delay = RETRY_CONFIG.baseDelay *
                      Math.pow(RETRY_CONFIG.backoffFactor, attempt - 1);
        return Math.min(delay, RETRY_CONFIG.maxDelay);
    }

    async function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function fetchWithRetry(url, options = {}, maxAttempts = RETRY_CONFIG.maxAttempts) {
        let lastError = null;
        let lastResponse = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const response = await fetchWithCache(url, options);
                if (response.ok) {
                    return response;
                }
                if (response.status === 401) {
                    throw new Error('Session expirée, veuillez vous reconnecter.');
                }
                if (response.status >= 400 && response.status < 500) {
                    lastResponse = response;
                    break;
                }
                lastError = new Error(`Statut HTTP ${response.status}`);
                lastResponse = response;
            } catch (error) {
                lastError = error;
            }

            if (attempt < maxAttempts) {
                const delay = getRetryDelay(attempt);
                console.warn(`[Proxy] Tentative ${attempt} échouée. Nouvel essai dans ${delay}ms...`);
                await sleep(delay);
            }
        }
        if (lastResponse && lastResponse.status >= 400 && lastResponse.status < 500) return lastResponse;
        throw new Error(`Échec après ${maxAttempts} tentatives: ${
            lastError ? lastError.message : 'Erreur inconnue'
        }`);
    }

    // ============================================================
    // 3. VÉRIFICATION DE LA DISPONIBILITÉ DU BACKEND
    // ------------------------------------------------------------
    // ⭐ BUG-CP-PROXY-401 : /api/version (PUBLIC) au lieu de /api/projects
    // ------------------------------------------------------------
    // JUSTIFICATION :
    //   - /api/version est public (backend.py : get_version() n'a PAS
    //     le décorateur @token_required). Il est donc testable sans
    //     authentification.
    //   - /api/projects exige un JWT valide → provoquait une erreur 401
    //     toutes les 30 s tant que l'utilisateur n'était pas authentifié.
    //   - Le mode hors ligne reste fonctionnel si le serveur est réellement
    //     injoignable (timeout, 5xx, erreur réseau).
    // ============================================================
    async function checkBackend() {
        if (IS_FILE_CONTEXT) return false;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);

            // Endpoint PUBLIC — aucun header d'authentification requis
            const response = await fetch(`${API_BASE_URL}/version`, {
                method: 'GET',
                credentials: USE_HTTPONLY_COOKIE ? 'include' : 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            // /api/version ne renvoie jamais 401 (endpoint public).
            // Seuls 5xx / timeout / erreur réseau déclenchent le mode hors ligne.
            const available = response.ok;

            if (available !== _isBackendAvailable) {
                _isBackendAvailable = available;
                if (!available) {
                    notifyBackendUnavailable();
                } else {
                    notifyBackendAvailable();
                }
            }
            return available;
        } catch (e) {
            if (_isBackendAvailable) {
                _isBackendAvailable = false;
                notifyBackendUnavailable();
            }
            console.warn('[Proxy] Backend indisponible, fallback vers IndexedDB/localStorage');
            return false;
        }
    }

    function notifyBackendUnavailable() {
        console.warn('[Proxy] ⚠️ Backend indisponible. Les données sont sauvegardées localement.');
        if (window.UI && typeof window.UI.showToast === 'function') {
            window.UI.showToast('⚠️ Serveur backend indisponible. Mode hors ligne (sauvegarde locale).', 'warning');
        }
        document.dispatchEvent(new CustomEvent('backendUnavailable', {
            detail: { timestamp: Date.now() }
        }));
    }

    function notifyBackendAvailable() {
        console.log('[Proxy] ✅ Backend de nouveau disponible.');
        if (window.UI && typeof window.UI.showToast === 'function') {
            window.UI.showToast('✅ Connexion au backend rétablie. Synchronisation automatique.', 'success');
        }
        document.dispatchEvent(new CustomEvent('backendAvailable', {
            detail: { timestamp: Date.now() }
        }));
        // Le backend est revenu : on tire les projets serveur ET on pousse
        // les projets locaux qui n'y sont pas encore (récupère une désync).
        syncPendingChanges();
        pushProjectsToBackend({ silent: true });
    }

    if (!IS_FILE_CONTEXT) {
        setTimeout(checkBackend, 100);
        setInterval(checkBackend, 30000);
        // Rattrapage périodique : repousse les projets locaux modifiés/créés
        // vers le serveur (ex: équipements ajoutés hors ligne). Silencieux.
        // Un premier essai après 5 s, puis toutes les 60 s.
        setTimeout(() => pushProjectsToBackend({ silent: true }), 5000);
        setInterval(() => pushProjectsToBackend({ silent: true }), 60000);
    }

    // ============================================================
    // 4. SYNCHRONISATION DES CHANGEMENTS PENDANTS
    // ============================================================
    async function syncPendingChanges() {
        if (isInternalSave()) {
            console.debug('[Proxy] syncPendingChanges ignoré (sauvegarde interne en cours)');
            return;
        }
        if (_syncInProgress) return;
        if (!_isBackendAvailable) {
            console.warn('[Proxy] Backend indisponible, synchronisation reportée.');
            return;
        }
        if (!isAuthenticated()) {
            console.warn('[Proxy] Non authentifié, synchronisation reportée.');
            return;
        }

        _syncInProgress = true;
        const saveToken = beginInternalSave();
        try {
            const projectId = ProjectManager.getCurrentProjectId();
            if (!projectId) {
                return;
            }

            console.log('[Proxy] Synchronisation des changements pendants...');

            const localEquipments = await StorageManager.loadEquipmentsForProject(projectId, true);
            if (!localEquipments || localEquipments.length === 0) {
                return;
            }

            let synced = 0;
            let failed = 0;
            for (const equipment of localEquipments) {
                try {
                    const success = await syncEquipment(equipment);
                    if (success) synced++;
                    else failed++;
                    if (_conflictedProjects.has(projectId)) break;
                } catch (error) {
                    failed++;
                    console.warn('[Proxy] Équipement non synchronisé:', equipment.id, error);
                }
            }

            if (synced > 0 || failed > 0) {
                console.log(`[Proxy] Synchronisation terminée: ${synced} réussis, ${failed} échecs.`);
                if (failed === 0 && synced > 0) {
                    _emitDataSynced({
                        type: 'sync',
                        count: synced
                    });
                }
            }
        } catch (e) {
            console.error('[Proxy] Erreur lors de la synchronisation:', e);
        } finally {
            endInternalSave();
            _syncInProgress = false;
        }
    }

        async function syncEquipment(equipment) {
        if (!_isBackendAvailable) {
            throw new Error('Backend indisponible');
        }
        if (!isAuthenticated()) {
            throw new Error('Non authentifié');
        }

        // ─────────────────────────────────────────────────────────
        // FIX 404 : le endpoint GET /api/equipments/<id> n'existe PAS
        // dans backend.py (seuls POST /api/equipments et PUT/DELETE
        // /api/equipments/<id> sont exposés). On détecte le 404 comme
        // "équipement absent" et on POST directement, sans tenter un
        // GET préalable qui échoue systématiquement.
        // ─────────────────────────────────────────────────────────
        try {
            // Étape 1 : tentative de création directe (POST).
            //   - 201 → créé
            //   - 409 → existe déjà → basculer sur PUT
            //   - 404 → projet parent manquant → vérifier côté projet
            let response = await fetchWithRetry(`${API_BASE_URL}/equipments`, withProjectVersion(equipment.projectId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(equipment)
            }), 2);

            if (response.status === 409) {
                let errorBody = {};
                try { errorBody = await response.clone().json(); } catch (e) {}
                if (errorBody.error === 'PROJECT_VERSION_CONFLICT') {
                    await recordProjectConflict(response, equipment.projectId);
                    return false;
                }
                response = await fetchWithRetry(`${API_BASE_URL}/equipments/${equipment.id}`, withProjectVersion(equipment.projectId, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(equipment)
                }), 2);
            }
            if (isProjectVersionFailure(response)) {
                await recordProjectConflict(response, equipment.projectId);
                return false;
            }
            if (!response.ok && response.status !== 201) {
                throw new Error(`Erreur création: ${response.status}`);
            }
            await rememberProjectVersion(response, equipment.projectId);
            return true;
        } catch (e) {
            console.warn(`[Proxy] Erreur sync équipement ${equipment.id}:`, e);
            throw e;
        }
    }

    // ============================================================
    // 5. PROXY : SAVE EQUIPMENT
    // ============================================================
    const originalSaveEquipment = StorageManager.saveEquipment;
    StorageManager.saveEquipment = async function(equipment) {
        const wasInSave = isInternalSave();
        const saveToken = wasInSave ? _currentSaveToken : beginInternalSave();

        try {
            const localPromise = originalSaveEquipment.call(this, equipment);

            if (!wasInSave && _isBackendAvailable && isAuthenticated()) {
                try {
                    let response = await fetchWithRetry(`${API_BASE_URL}/equipments`, withProjectVersion(equipment.projectId, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(equipment)
                    }), RETRY_CONFIG.maxAttempts);
                    let responseBody = {};
                    if (response.status === 409) {
                        try { responseBody = await response.clone().json(); } catch (e) {}
                        if (responseBody.error === 'PROJECT_VERSION_CONFLICT') {
                            // The shared response handler below records the conflict once.
                        } else {
                            response = await fetchWithRetry(`${API_BASE_URL}/equipments/${equipment.id}`, withProjectVersion(equipment.projectId, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(equipment)
                            }), RETRY_CONFIG.maxAttempts);
                        }
                    }
                    if (isProjectVersionFailure(response)) {
                        await recordProjectConflict(response, equipment.projectId);
                    } else if (!response.ok) {
                        const text = await response.text();
                        console.warn('[Proxy] Erreur sauvegarde backend:', text);
                    } else {
                        await rememberProjectVersion(response, equipment.projectId);
                        _lastSyncData = equipment;
                        _lastSyncTimestamp = Date.now();
                    }
                } catch (e) {
                    console.warn('[Proxy] Erreur sauvegarde backend (après retry):', e);
                    if (e.message && e.message.includes('session expirée')) {
                        clearToken();
                    } else {
                        _isBackendAvailable = false;
                        notifyBackendUnavailable();
                    }
                }
            }

            await localPromise;

            _emitDataSynced({
                type: 'equipmentSaved',
                id: equipment.id
            });

            return equipment;
        } finally {
            if (!wasInSave) {
                endInternalSave();
            }
        }
    };

    // ============================================================
    // 6. PROXY : DELETE EQUIPMENT
    // ============================================================
    const originalDeleteEquipment = StorageManager.deleteEquipment;
    StorageManager.deleteEquipment = async function(equipmentId) {
        const wasInSave = isInternalSave();
        const saveToken = wasInSave ? _currentSaveToken : beginInternalSave();
        const equipment = ProjectManager.getState().equipments.find(item => item.id === equipmentId);
        const projectId = equipment && equipment.projectId;

        try {
            const localPromise = originalDeleteEquipment.call(this, equipmentId);

            if (!wasInSave && _isBackendAvailable && isAuthenticated()) {
                try {
                    const response = await fetchWithRetry(`${API_BASE_URL}/equipments/${equipmentId}`, withProjectVersion(projectId, {
                        method: 'DELETE'
                    }), RETRY_CONFIG.maxAttempts);
                    if (isProjectVersionFailure(response) && projectId) {
                        await recordProjectConflict(response, projectId);
                    } else if (!response.ok) {
                        const text = await response.text();
                        console.warn('[Proxy] Erreur suppression backend:', text);
                    } else {
                        if (projectId) await rememberProjectVersion(response, projectId);
                        _lastSyncTimestamp = Date.now();
                    }
                } catch (e) {
                    console.warn('[Proxy] Erreur suppression backend (après retry):', e);
                    if (e.message && e.message.includes('session expirée')) {
                        clearToken();
                    } else {
                        _isBackendAvailable = false;
                        notifyBackendUnavailable();
                    }
                }
            }

            await localPromise;

            _emitDataSynced({
                type: 'equipmentDeleted',
                id: equipmentId
            });

            return true;
        } finally {
            if (!wasInSave) {
                endInternalSave();
            }
        }
    };

    // ============================================================
    // 7. PROXY : LOAD EQUIPMENTS (avec cache)
    // ============================================================
    const originalLoadEquipmentsForProject = StorageManager.loadEquipmentsForProject;
    StorageManager.loadEquipmentsForProject = async function(projectId, forceRefresh) {
        if ((forceRefresh || _isBackendAvailable) && isAuthenticated() && !isInternalSave()) {
            try {
                const response = await fetchWithRetry(`${API_BASE_URL}/projects/${projectId}/equipments`, {
                    method: 'GET'
                }, RETRY_CONFIG.maxAttempts);
                if (response.ok) {
                    const data = await response.json();
                    if (data && Array.isArray(data.items)) {
                        rememberProjectVersionValue(projectId, data.projectVersion);
                        const equipments = data.items.map(eq => {
                            const result = {
                                id: eq.id,
                                tag: eq.tag,
                                type: eq.type,
                                surface: eq.surface,
                                projectId: eq.project_id || eq.projectId,
                                included: eq.included === 1 || eq.included === true,
                                systemId: eq.system_id || eq.systemId,
                                dimensions: eq.dimensions || {},
                                coordinates: (typeof eq.coordinates === 'string' && eq.coordinates !== '') ?
                                    (() => { try { return JSON.parse(eq.coordinates); } catch(e) { return null; } })() :
                                    (eq.coordinates || null),
                                material: eq.material || 'acier',
                                wallThickness: eq.wallThickness || 8.0,
                                coatingType: eq.coatingType || '3LPE',
                                coatingCondition: eq.coatingCondition || 'neuf',
                                coatingThickness: eq.coatingThickness || 0,
                                soilResistivity: eq.soilResistivity || 0,
                                cpData: eq.cpData || { parameters: {}, results: {}, calculated: false }
                            };
                            if (eq.data) {
                                for (const [key, value] of Object.entries(eq.data)) {
                                    if (!(key in result) || result[key] === null || (typeof result[key] === 'object' && !Array.isArray(result[key]) && Object.keys(result[key]).length === 0)) {
                                        result[key] = value;
                                    }
                                }
                            }
                            return result;
                        });

                        try {
                            if (window.StorageManager && window.StorageManager._memoryCache) {
                                window.StorageManager._memoryCache.equipments.set(projectId, equipments);
                            }
                        } catch (e) {}

                        _lastSyncTimestamp = Date.now();
                        return equipments;
                    }
                }
            } catch (e) {
                console.warn('[Proxy] Erreur chargement backend (après retry):', e);
                if (e.message && e.message.includes('session expirée')) {
                    clearToken();
                } else {
                    _isBackendAvailable = false;
                    notifyBackendUnavailable();
                }
            }
        }

        const result = await originalLoadEquipmentsForProject.call(this, projectId, forceRefresh);
        return result;
    };

    // ============================================================
    // 8. PROXY : SAVE PROJECT
    // ============================================================
    const originalSaveProject = StorageManager.saveProject;
    StorageManager.saveProject = async function(project) {
        const wasInSave = isInternalSave();
        const saveToken = wasInSave ? _currentSaveToken : beginInternalSave();

        try {
            const localPromise = originalSaveProject.call(this, project);

             // ─────────────────────────────────────────────────────────
            // FIX 401 : garde-fou supplémentaire.
            // ---------------------------------------------------------
            // On n'essaie PAS d'appeler le backend si :
            //   - pas de token en mémoire
            //   - OR le dernier 401 est < 5 s (cascade de requêtes)
            // Le backend ne doit être appelé qu'après une
            // authentification réussie et stable.
            // ─────────────────────────────────────────────────────────
            const last401 = window._cpLastAuthExpiredSignal || 0;
            const recentlyExpired = (Date.now() - last401) < 5000;
            const canCallBackend = !wasInSave
                && _isBackendAvailable
                && isAuthenticated()
                && !recentlyExpired
                && !_conflictedProjects.has(project.id);

            if (canCallBackend) {
                try {
                    // ───────────────────────────────────────────────────
                    // FIX 404 : en cas de 404 sur PUT, basculer sur POST
                    // ───────────────────────────────────────────────────
                    let response = await fetchWithRetry(`${API_BASE_URL}/projects/${project.id}`, withProjectVersion(project.id, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(project.data)
                    }), RETRY_CONFIG.maxAttempts);

                    if (response.status === 404) {
                        // Fallback : créer le projet côté backend
                        console.info('[Proxy] 404 sur PUT projet → tentative POST create:', project.id);
                        const createResponse = await fetchWithRetry(`${API_BASE_URL}/projects`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                id: project.id,
                                name: project.name || project.id,
                                type: project.type || 'mixte',
                                data: project.data
                            })
                        }, RETRY_CONFIG.maxAttempts);
                        if (createResponse.ok) {
                            await rememberProjectVersion(createResponse, project.id);
                            response = createResponse;
                        } else if (createResponse.status === 409) {
                            response = await fetchWithRetry(`${API_BASE_URL}/projects/${project.id}`, withProjectVersion(project.id, {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(project.data)
                            }), RETRY_CONFIG.maxAttempts);
                        }
                    }

                    if (isProjectVersionFailure(response)) {
                        await recordProjectConflict(response, project.id);
                    } else if (!response.ok) {
                        const text = await response.text();
                        console.warn('[Proxy] Erreur sauvegarde projet backend:', response.status, text);
                    } else {
                        await rememberProjectVersion(response, project.id);
                        _lastSyncTimestamp = Date.now();
                    }
                } catch (e) {
                    console.warn('[Proxy] Erreur sauvegarde projet backend (après retry):', e);
                    if (e.message && e.message.includes('session expirée')) {
                        clearToken();
                    } else {
                        _isBackendAvailable = false;
                        notifyBackendUnavailable();
                    }
                }
            }

            await localPromise;

            _emitDataSynced({
                type: 'projectSaved',
                id: project.id
            });

            return project;
        } finally {
            if (!wasInSave) {
                endInternalSave();
            }
        }
    };

    // ============================================================
    // 9. PROXY : FULL SYNC
    // ============================================================
    StorageManager.fullSync = async function(projectId) {
        if (!projectId) {
            projectId = ProjectManager.getCurrentProjectId();
        }
        if (!projectId) {
            console.warn('[Proxy] Aucun projet actif pour la sync');
            return false;
        }

        if (_conflictedProjects.has(projectId)) {
            console.warn('[Proxy] Sync suspendue : conflit de version non résolu pour', projectId);
            return false;
        }

        if (isInternalSave()) {
            console.debug('[Proxy] fullSync ignoré (sauvegarde interne en cours)');
            return false;
        }

        if (_syncInProgress) {
            console.warn('[Proxy] Synchronisation déjà en cours');
            return false;
        }

        const available = await checkBackend();
        if (!available) {
            console.warn('[Proxy] Backend indisponible, sync impossible');
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('⚠️ Synchronisation impossible : backend indisponible.', 'warning');
            }
            return false;
        }

        if (!isAuthenticated()) {
            console.warn('[Proxy] Non authentifié, sync impossible');
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('⚠️ Synchronisation impossible : veuillez vous connecter.', 'warning');
            }
            return false;
        }

        _syncInProgress = true;
        const saveToken = beginInternalSave();
        try {
            const state = ProjectManager.getState();
            const syncData = {
                ...state,
                equipments: state.equipments
            };

            const response = await fetchWithRetry(`${API_BASE_URL}/projects/${projectId}/full-sync`, withProjectVersion(projectId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(syncData)
            }), RETRY_CONFIG.maxAttempts);

            if (response.ok) {
                await rememberProjectVersion(response, projectId);
                console.log('[Proxy] Sync complète réussie');
                _lastSyncTimestamp = Date.now();
                if (window.UI && typeof window.UI.showToast === 'function') {
                    window.UI.showToast('✅ Synchronisation complète réussie.', 'success');
                }
                _emitDataSynced({
                    type: 'fullSync'
                });
                return true;
            } else if (isProjectVersionFailure(response)) {
                await recordProjectConflict(response, projectId);
                return false;
            } else {
                const text = await response.text();
                console.warn('[Proxy] Erreur sync:', text);
                if (window.UI && typeof window.UI.showToast === 'function') {
                    window.UI.showToast('⚠️ Erreur lors de la synchronisation complète.', 'warning');
                }
                return false;
            }
        } catch (e) {
            console.warn('[Proxy] Erreur sync (après retry):', e);
            if (e.message && e.message.includes('session expirée')) {
                clearToken();
            } else {
                _isBackendAvailable = false;
                notifyBackendUnavailable();
            }
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('❌ Échec de la synchronisation. Mode hors ligne.', 'error');
            }
            return false;
        } finally {
            endInternalSave();
            _syncInProgress = false;
        }
    };

    // ============================================================
    // 9bis. PROXY : PULL PROJETS (restauration serveur → navigateur)
    // ------------------------------------------------------------
    // ⭐ PULL-BOOTSTRAP : la lecture locale (loadProjects) reste la
    // source du rendu. Historiquement, seul un PUSH local → serveur
    // existait, ce qui rendait les projets « invisibles » dès que
    // l'IndexedDB/localStorage du navigateur était vide (nouvelle
    // origine, cache purgé, autre profil…).
    // Ce mécanisme tire les projets + équipements du serveur vers
    // le stockage local APRÈS login (ou au démarrage si déjà
    // authentifié). Écriture LOCALE uniquement (pas de re-push).
    // ============================================================
    let _pullInProgress = false;

    async function _pullEquipments(projectId) {
        try {
            const response = await fetchWithRetry(
                `${API_BASE_URL}/projects/${projectId}/equipments`,
                { method: 'GET' }, RETRY_CONFIG.maxAttempts);
            if (!response.ok) return 0;
            const data = await response.json();
            if (!data || !Array.isArray(data.items)) return 0;
            rememberProjectVersionValue(projectId, data.projectVersion);
            let count = 0;
            for (const eq of data.items) {
                const record = {
                    id: eq.id,
                    tag: eq.tag,
                    type: eq.type,
                    surface: eq.surface,
                    projectId: eq.project_id || eq.projectId,
                    included: eq.included === 1 || eq.included === true,
                    systemId: eq.system_id || eq.systemId,
                    dimensions: eq.dimensions || {},
                    coordinates: (typeof eq.coordinates === 'string' && eq.coordinates !== '')
                        ? (() => { try { return JSON.parse(eq.coordinates); } catch (e) { return null; } })()
                        : (eq.coordinates || null),
                    material: eq.material || 'acier',
                    wallThickness: eq.wallThickness || 8.0,
                    coatingType: eq.coatingType || '3LPE',
                    coatingCondition: eq.coatingCondition || 'neuf',
                    coatingThickness: eq.coatingThickness || 0,
                    soilResistivity: eq.soilResistivity || 0,
                    cpData: eq.cpData || { parameters: {}, results: {}, calculated: false }
                };
                if (eq.data) {
                    for (const [key, value] of Object.entries(eq.data)) {
                        if (!(key in record) || record[key] === null ||
                            (typeof record[key] === 'object' && !Array.isArray(record[key]) &&
                             Object.keys(record[key]).length === 0)) {
                            record[key] = value;
                        }
                    }
                }
                await originalSaveEquipment.call(StorageManager, record);
                count++;
            }
            return count;
        } catch (e) {
            console.warn('[Proxy] PULL équipements échoué pour', projectId, e);
            return 0;
        }
    }

    async function pullProjectsFromBackend(options = {}) {
        const silent = options.silent === true;
        if (_pullInProgress) return false;
        if (isInternalSave()) return false;
        if (!_isBackendAvailable) { try { await checkBackend(); } catch (e) {} }
        if (!_isBackendAvailable || !isAuthenticated()) return false;

        _pullInProgress = true;
        try {
            const listRes = await fetchWithRetry(`${API_BASE_URL}/projects?limit=200`,
                { method: 'GET' }, RETRY_CONFIG.maxAttempts);
            if (!listRes.ok) return false;
            const list = await listRes.json();
            const items = (list && Array.isArray(list.items)) ? list.items : [];
            if (items.length === 0) return false;

            let projectsCount = 0;
            let eqTotal = 0;
            for (const item of items) {
                if (!item || !item.id) continue;
                const detailRes = await fetchWithRetry(`${API_BASE_URL}/projects/${item.id}`,
                    { method: 'GET' }, RETRY_CONFIG.maxAttempts);
                if (!detailRes.ok) continue;
                await rememberProjectVersion(detailRes, item.id);
                const detail = await detailRes.json();
                let data = detail.data;
                if (typeof data === 'string') {
                    try { data = JSON.parse(data); } catch (e) { data = null; }
                }
                if (!data || typeof data !== 'object') data = {};
                data.project = data.project || {};
                data.project.id = item.id;
                if (item.name) data.project.name = item.name;

                await originalSaveProject.call(StorageManager, {
                    id: item.id,
                    name: item.name || item.id,
                    type: item.type || data.project.cpSystemType || 'mixte',
                    createdAt: item.created_at || data.project.createdAt || new Date().toISOString(),
                    updatedAt: item.updated_at || new Date().toISOString(),
                    data: data
                });
                projectsCount++;
                eqTotal += await _pullEquipments(item.id);
            }

            console.log('[Proxy] ⭐ PULL-BOOTSTRAP : ' + projectsCount +
                        ' projet(s) et ' + eqTotal + ' équipement(s) restaurés depuis le serveur.');
            if (!silent && window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('🔄 Données synchronisées depuis le serveur (' +
                    projectsCount + ' projet(s)).', 'info');
            }
            document.dispatchEvent(new CustomEvent('projectsPulled', {
                detail: { projects: projectsCount, equipments: eqTotal }
            }));
            return projectsCount > 0;
        } catch (e) {
            console.warn('[Proxy] PULL-BOOTSTRAP échoué:', e);
            return false;
        } finally {
            _pullInProgress = false;
        }
    }

    // ============================================================
    // 9-bis. PUSH PROJETS → BACKEND (sync auto navigateur → serveur)
    // ============================================================
    // Complément de pullProjectsFromBackend (serveur → navigateur).
    // Pousse les projets créés/modifiés localement vers le serveur pour
    // que le Dashboard (qui lit la base serveur) les voie aussi.
    // SÉCURITÉ : UPSERT. Le backend `PUT /api/projects/<id>` crée le projet
    // s'il est absent, sans écrasement destructif. Un drapeau local
    // `cp_pushed_projects` évite de repousser un projet inchangé.
    let _pushInProgress = false;

    function _getPushedMap() {
        try { return JSON.parse(localStorage.getItem('cp_pushed_projects') || '{}'); }
        catch (e) { return {}; }
    }
    function _setPushedMap(map) {
        try { localStorage.setItem('cp_pushed_projects', JSON.stringify(map)); } catch (e) {}
    }
    // Empreinte simple d'un projet pour détecter un changement sans repousser à l'identique.
    function _projectFingerprint(project) {
        try {
            const s = JSON.stringify(project.data || {});
            return s.length + ':' + (s.slice(0, 64)) + ':' + (s.slice(-64));
        } catch (e) { return String(Date.now()); }
    }

    // Pousse les équipements embarqués d'un projet (data.equipments), en
    // respectant la version du projet (If-Match) comme le fait saveEquipment.
    async function _pushProjectEquipments(project) {
        const eqs = (project.data && Array.isArray(project.data.equipments)) ? project.data.equipments : [];
        if (eqs.length === 0) return;
        let version = _projectVersions.get(project.id);
        for (const eq of eqs) {
            if (!eq || !eq.id) continue;
            const payload = Object.assign({}, eq);
            payload.projectId = payload.projectId || project.id;
            try {
                let er = await fetchWithRetry(`${API_BASE_URL}/equipments`,
                    withProjectVersion(project.id, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    }), RETRY_CONFIG.maxAttempts);
                if (er.status === 409) {
                    er = await fetchWithRetry(`${API_BASE_URL}/equipments/${encodeURIComponent(eq.id)}`,
                        withProjectVersion(project.id, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        }), RETRY_CONFIG.maxAttempts);
                }
                try { const vj = await er.clone().json(); if (vj.version) { version = vj.version; rememberProjectVersionValue(project.id, version); } } catch (e) {}
            } catch (e) {
                console.warn('[Proxy] Push équipement échoué:', eq.id, e.message);
            }
        }
    }

    /**
     * Pousse les projets locaux absents ou modifiés côté serveur.
     * Silencieux et idempotent. UPSERT : jamais d'écrasement destructif.
     * @returns {Promise<number>} nombre de projets effectivement poussés.
     */
    async function pushProjectsToBackend(options = {}) {
        const silent = options.silent === true;
        if (IS_FILE_CONTEXT) return 0;
        if (_pushInProgress) return 0;
        if (isInternalSave()) return 0;
        if (!_isBackendAvailable) { try { await checkBackend(); } catch (e) {} }
        if (!_isBackendAvailable || !isAuthenticated()) return 0;

        _pushInProgress = true;
        let pushed = 0;
        try {
            const localProjects = await StorageManager.loadProjects();
            if (!Array.isArray(localProjects) || localProjects.length === 0) return 0;

            // IDs déjà connus du serveur (une seule requête)
            let serverIds = new Set();
            try {
                const listRes = await fetchWithRetry(`${API_BASE_URL}/projects?limit=200`,
                    { method: 'GET' }, RETRY_CONFIG.maxAttempts);
                if (listRes.ok) {
                    const list = await listRes.json();
                    (list.items || []).forEach(i => serverIds.add(i.id));
                }
            } catch (e) { /* le PUT décidera */ }

            const pushedMap = _getPushedMap();

            for (const project of localProjects) {
                if (!project || !project.id) continue;
                const fp = _projectFingerprint(project);
                const already = pushedMap[project.id];
                if (serverIds.has(project.id) && already && already.fp === fp) continue;

                try {
                    let response = await fetchWithRetry(
                        `${API_BASE_URL}/projects/${encodeURIComponent(project.id)}`,
                        withProjectVersion(project.id, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(project.data || {})
                        }), RETRY_CONFIG.maxAttempts);

                    if (response.status === 404) {
                        const createRes = await fetchWithRetry(`${API_BASE_URL}/projects`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                id: project.id,
                                name: (project.data && project.data.project && project.data.project.name) || project.name || project.id,
                                type: (project.data && project.data.project && project.data.project.cpSystemType) || project.type || 'mixte',
                                data: project.data
                            })
                        }, RETRY_CONFIG.maxAttempts);
                        response = createRes;
                    }

                    if (isProjectVersionFailure(response)) {
                        await recordProjectConflict(response, project.id);
                        continue;
                    }
                    if (!response.ok) {
                        console.warn('[Proxy] Push projet échoué:', project.id, response.status);
                        continue;
                    }
                    await rememberProjectVersion(response, project.id);
                    pushedMap[project.id] = { fp, ts: Date.now() };
                    pushed++;
                    await _pushProjectEquipments(project);
                } catch (e) {
                    console.warn('[Proxy] Push projet (après retry) échoué:', project.id, e.message);
                }
            }

            _setPushedMap(pushedMap);
            if (pushed > 0) {
                console.log(`[Proxy] Push auto : ${pushed} projet(s) envoye(s) au serveur.`);
                if (!silent && window.UI && typeof window.UI.showToast === 'function') {
                    window.UI.showToast(`${pushed} projet(s) synchronise(s) avec le serveur.`, 'success');
                }
                document.dispatchEvent(new CustomEvent('projectsPushed', { detail: { count: pushed } }));
            }
            return pushed;
        } catch (e) {
            console.warn('[Proxy] pushProjectsToBackend echoue:', e);
            return pushed;
        } finally {
            _pushInProgress = false;
        }
    }

    // ============================================================
    // 10. MÉTHODES D'UTILITÉ
    // ============================================================
    StorageManager.isBackendAvailable = function() {
        return _isBackendAvailable;
    };

    StorageManager.checkBackend = checkBackend;
    StorageManager.pullProjectsFromBackend = pullProjectsFromBackend;
    StorageManager.pushProjectsToBackend = pushProjectsToBackend;

    StorageManager.getLastSyncTimestamp = function() {
        return _lastSyncTimestamp;
    };

    StorageManager.getLastSyncData = function() {
        return _lastSyncData;
    };

    StorageManager.isAuthenticated = isAuthenticated;
    StorageManager.getToken = getToken;
    StorageManager.setToken = setToken;
    StorageManager.clearToken = clearToken;
    StorageManager.login = login;
    StorageManager.logout = logout;
    StorageManager.getUserId = getUserId;
    StorageManager.getUserRole = getUserRole;
    StorageManager.syncPendingChanges = syncPendingChanges;
    StorageManager.isInternalSave = isInternalSave;
    StorageManager.getSaveDepth = function() { return _saveDepth; };
    StorageManager.getCurrentSaveToken = function() { return _currentSaveToken; };

    // V04 : CSRF helpers exposés
    StorageManager.setCsrfToken = setCsrfToken;
    StorageManager.getCsrfToken = getCsrfToken;
    StorageManager.usesHttpOnlyCookie = function() { return USE_HTTPONLY_COOKIE; };

    // ⭐ CRITICAL-01 : helper d'initialisation exposé
    StorageManager.ensureHttpOnlyModeReady = ensureHttpOnlyModeReady;

    // ============================================================
    // 11. SAUVEGARDE AUTOMATIQUE ET SYNC PÉRIODIQUE
    // ============================================================
    setInterval(async () => {
        if (isInternalSave()) return;
        if (_isBackendAvailable && isAuthenticated() && !_syncInProgress) {
            try {
                const projectId = ProjectManager.getCurrentProjectId();
                if (projectId) {
                    await StorageManager.fullSync(projectId);
                }
            } catch (e) {
                console.warn('[Proxy] Erreur sync périodique:', e);
            }
        }
    }, 120000);

    // ============================================================
    // 12. ÉCOUTEURS D'ÉVÉNEMENTS
    // ============================================================

    // ----------------------------------------------------------------
    // projectLoaded : synchronisation après chargement de projet
    // ----------------------------------------------------------------
    document.addEventListener('projectLoaded', function() {
        setTimeout(() => {
            if (isInternalSave()) {
                console.debug('[Proxy] projectLoaded ignoré (sauvegarde interne)');
                return;
            }
            if (_isBackendAvailable && isAuthenticated()) {
                const projectId = ProjectManager.getCurrentProjectId();
                if (projectId) {
                    StorageManager.fullSync(projectId).catch(e =>
                        console.warn('[Proxy] Sync après projectLoaded:', e));
                }
            }
        }, 2000);
    });

    // ----------------------------------------------------------------
    // equipmentUpdated : synchronisation différée après mise à jour
    // ----------------------------------------------------------------
    document.addEventListener('equipmentUpdated', function(e) {
        const eqId = e.detail?.equipmentId;
        if (eqId && _isBackendAvailable && isAuthenticated()) {
            clearTimeout(window._syncTimeout);
            window._syncTimeout = setTimeout(() => {
                if (isInternalSave()) {
                    console.debug('[Proxy] equipmentUpdated sync ignorée (sauvegarde interne)');
                    return;
                }
                const projectId = ProjectManager.getCurrentProjectId();
                if (projectId) {
                    StorageManager.fullSync(projectId).catch(e =>
                        console.warn('[Proxy] Sync après equipmentUpdated:', e));
                }
            }, 5000);
        }
    });

    // ----------------------------------------------------------------
    // dataSynced : mettre à jour le timestamp de dernière sync
    // ⚠️ Anti-récursion : ne réagir QUE si l'événement n'est PAS marqué
    //    _fromSave. Sinon, ignorer silencieusement.
    // ----------------------------------------------------------------
    document.addEventListener('dataSynced', function(e) {
        const detail = e.detail || {};

        if (detail._fromSave === true) {
            return;
        }
        if (isInternalSave()) {
            return;
        }

        _lastSyncTimestamp = Date.now();
        _lastSyncData = detail;
    });

    // ============================================================
    // 13. INITIALISATION ASYNCHRONE DU MODE HTTPONLY (CRITICAL-01)
    // ============================================================
    // L'init est lancée immédiatement, en parallèle du reste.
    // login() et logout() attendent sa résolution via
    // ensureHttpOnlyModeReady() avant d'opérer.
    //
    // Le module reste fonctionnel en attendant : si un appel login()
    // survient avant la fin de l'init, il sera automatiquement mis
    // en attente (await) — pas de race condition.
    // ============================================================
    ensureHttpOnlyModeReady();

    // ⭐ PULL-BOOTSTRAP au démarrage : si une session existe déjà
    // (token legacy persisté), restaurer les données du serveur.
    setTimeout(() => {
        try {
            if (isAuthenticated()) {
                pullProjectsFromBackend({ silent: true }).catch(() => {});
            }
        } catch (e) {}
    }, 4000);

    console.log('[Proxy] Couche de persistance active - Backend + IndexedDB');
    console.log('[Proxy] Authentification JWT intégrée.');
    console.log('[Proxy] ⭐ CRITICAL-01 : mode HttpOnly lu depuis /api/version (SSOT).');
    console.log('[Proxy] 🔒 CSRF protection activée sur POST/PUT/PATCH/DELETE (si HttpOnly actif).');
    console.log('[Proxy] 🔒 JWT révocable côté backend via table revoked_tokens (CRITICAL-03).');
    console.log('[Proxy] ⚠️ P1-04 CORRIGÉ : Anti-récursion robuste (compteur _saveDepth + token _saveToken)');
    console.log('[Proxy] 🔒 Émissions dataSynced centralisées via _emitDataSynced() (toujours _fromSave=true)');
    console.log('[Proxy] ⭐ BUG-CP-PROXY-401 CORRIGÉ : checkBackend() utilise /api/version (public).');

})();

// ============================================================
// FIN DE storage-proxy.js (VERSION 8.11 – V04 + CRITICAL-01 + BUG-CP-PROXY-401)
// ============================================================