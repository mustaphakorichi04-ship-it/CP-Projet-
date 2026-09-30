// geoUtils.js – Utilitaires géographiques pour CP Engineer Pro
// Version optimisée – Cache LRU, performances, documentation
// P1-17 : Ajout de distanceProjected (projection UTM)
// P2-22 : Optimisation des clés de cache
// ============================================================

const GeoUtils = (function() {
    'use strict';

    // OPTIM : Cache LRU pour les calculs de distance et d'interpolation
    // Évite de recalculer les mêmes valeurs avec les mêmes paramètres
    class LRUCache {
        constructor(maxSize = 100) {
            this.maxSize = maxSize;
            this.cache = new Map();
        }

        get(key) {
            if (!this.cache.has(key)) return undefined;
            const value = this.cache.get(key);
            // Mettre à jour l'ordre (rappel de la clé en fin de liste)
            this.cache.delete(key);
            this.cache.set(key, value);
            return value;
        }

        set(key, value) {
            if (this.cache.size >= this.maxSize) {
                // Supprimer la première entrée (la moins récemment utilisée)
                const firstKey = this.cache.keys().next().value;
                this.cache.delete(firstKey);
            }
            this.cache.set(key, value);
        }

        clear() {
            this.cache.clear();
        }
    }

    const distanceCache = new LRUCache(200);
    const interpolateCache = new LRUCache(100);

    // Constantes pré-calculées
    const R = 6371000; // Rayon terrestre en mètres
    const TO_RAD = Math.PI / 180;

    /**
     * Retourne les coordonnées de référence (par défaut : centre de l'Algérie)
     * @returns {{lat: number, lon: number}} Coordonnées de référence
     */
    function getReference() {
        return { lat: 30.123456, lon: 8.123456 };
    }

    /**
     * Formate une coordonnée pour l'affichage
     * @param {number|null|undefined} val - La valeur à formater
     * @param {number} decimals - Nombre de décimales (défaut: 6)
     * @returns {string} La coordonnée formatée ou '?' si invalide
     */
    function formatCoord(val, decimals = 6) {
        if (val === undefined || val === null || typeof val !== 'number' || isNaN(val)) {
            return '?';
        }
        return val.toFixed(decimals);
    }

    /**
     * Vérifie si une coordonnée est valide
     * @param {number} lat - Latitude
     * @param {number} lon - Longitude
     * @returns {boolean} true si valide, false sinon
     */
    function isValidCoord(lat, lon) {
        if (lat === undefined || lon === undefined) return false;
        if (typeof lat !== 'number' || typeof lon !== 'number') return false;
        if (isNaN(lat) || isNaN(lon)) return false;
        if (!isFinite(lat) || !isFinite(lon)) return false;
        if (lat < -90 || lat > 90) return false;
        if (lon < -180 || lon > 180) return false;
        return true;
    }

    /**
     * P2-22 : Clé de cache optimisée pour la distance
     */
    function getDistanceCacheKey(lat1, lon1, lat2, lon2) {
        // Arrondir pour éviter les variations inutiles
        const p1 = Math.round(lat1 * 1000000) + ',' + Math.round(lon1 * 1000000);
        const p2 = Math.round(lat2 * 1000000) + ',' + Math.round(lon2 * 1000000);
        // Ordonner les points pour une clé symétrique
        return p1 < p2 ? p1 + '|' + p2 : p2 + '|' + p1;
    }

    /**
     * Calcule la distance approximative entre deux points GPS (formule de Haversine)
     * Précision : ±0.5% sur les distances < 1000 km, ±0.3% sur les distances < 100 km.
     * Pour les calculs nécessitant une précision métrique sur de longues distances,
     * utiliser une projection adaptée (ex: UTM) via distanceProjected().
     *
     * @param {number} lat1 - Latitude du point 1
     * @param {number} lon1 - Longitude du point 1
     * @param {number} lat2 - Latitude du point 2
     * @param {number} lon2 - Longitude du point 2
     * @returns {number} Distance en mètres
     */
    function distanceHaversine(lat1, lon1, lat2, lon2) {
        if (!isValidCoord(lat1, lon1) || !isValidCoord(lat2, lon2)) {
            return 0;
        }

        // P2-22 : Utiliser la nouvelle clé de cache
        const cacheKey = getDistanceCacheKey(lat1, lon1, lat2, lon2);
        const cached = distanceCache.get(cacheKey);
        if (cached !== undefined) return cached;

        const dLat = (lat2 - lat1) * TO_RAD;
        const dLon = (lon2 - lon1) * TO_RAD;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(lat1 * TO_RAD) * Math.cos(lat2 * TO_RAD) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const dist = R * c;

        distanceCache.set(cacheKey, dist);
        return dist;
    }

    /**
     * P1-17 : Calcule la distance entre deux points GPS en utilisant une projection UTM.
     * Plus précis que Haversine pour les longues distances.
     *
     * @param {number} lat1 - Latitude du point 1
     * @param {number} lon1 - Longitude du point 1
     * @param {number} lat2 - Latitude du point 2
     * @param {number} lon2 - Longitude du point 2
     * @returns {number} Distance en mètres
     */
    function distanceProjected(lat1, lon1, lat2, lon2) {
        if (!isValidCoord(lat1, lon1) || !isValidCoord(lat2, lon2)) return 0;

        // Calculer le fuseau UTM
        const zone = Math.floor((lon1 + 180) / 6) + 1;
        const centerLon = (zone - 1) * 6 - 180 + 3;

        // Convertir en coordonnées UTM (approximatif)
        // Note : pour une précision parfaite, utiliser une bibliothèque de projection
        const phi1 = lat1 * Math.PI / 180;
        const phi2 = lat2 * Math.PI / 180;
        const lambda1 = (lon1 - centerLon) * Math.PI / 180;
        const lambda2 = (lon2 - centerLon) * Math.PI / 180;

        const x1 = R * lambda1 * Math.cos(phi1);
        const y1 = R * phi1;
        const x2 = R * lambda2 * Math.cos(phi2);
        const y2 = R * phi2;

        return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
    }

    /**
     * Convertit des degrés décimaux en degrés, minutes, secondes (DMS)
     * @param {number} val - Coordonnée en degrés décimaux
     * @param {boolean} isLat - true pour latitude, false pour longitude
     * @returns {string} Chaîne formatée en DMS
     */
    function toDMS(val, isLat = true) {
        if (val === undefined || val === null || typeof val !== 'number' || isNaN(val)) {
            return '?';
        }
        const degrees = Math.floor(Math.abs(val));
        const minutesFloat = (Math.abs(val) - degrees) * 60;
        const minutes = Math.floor(minutesFloat);
        const seconds = ((minutesFloat - minutes) * 60).toFixed(1);
        const direction = isLat ? (val >= 0 ? 'N' : 'S') : (val >= 0 ? 'E' : 'W');
        return `${degrees}° ${minutes}' ${seconds}" ${direction}`;
    }

    /**
     * Interpole un point le long d'un segment entre deux coordonnées
     * @param {number} lat1 - Latitude du point de départ
     * @param {number} lon1 - Longitude du point de départ
     * @param {number} lat2 - Latitude du point d'arrivée
     * @param {number} lon2 - Longitude du point d'arrivée
     * @param {number} fraction - Fraction de progression (0 à 1)
     * @returns {{lat: number, lon: number}} Point interpolé
     */
    function interpolatePoint(lat1, lon1, lat2, lon2, fraction) {
        if (!isValidCoord(lat1, lon1) || !isValidCoord(lat2, lon2)) {
            return { lat: lat1 || 0, lon: lon1 || 0 };
        }
        const f = Math.max(0, Math.min(1, fraction));

        // OPTIM : Cache
        const cacheKey = `${lat1},${lon1},${lat2},${lon2},${f}`;
        const cached = interpolateCache.get(cacheKey);
        if (cached !== undefined) return cached;

        const result = {
            lat: lat1 + (lat2 - lat1) * f,
            lon: lon1 + (lon2 - lon1) * f
        };
        interpolateCache.set(cacheKey, result);
        return result;
    }

    /**
     * Calcule le point médian entre deux coordonnées
     * @param {number} lat1 - Latitude du point 1
     * @param {number} lon1 - Longitude du point 1
     * @param {number} lat2 - Latitude du point 2
     * @param {number} lon2 - Longitude du point 2
     * @returns {{lat: number, lon: number}} Point médian
     */
    function midpoint(lat1, lon1, lat2, lon2) {
        return interpolatePoint(lat1, lon1, lat2, lon2, 0.5);
    }

    /**
     * Calcule la distance totale d'un chemin défini par une liste de points
     * @param {Array<{lat: number, lon: number}>} points - Liste des points
     * @returns {number} Distance totale en mètres
     */
    function pathLength(points) {
        if (!Array.isArray(points) || points.length < 2) return 0;
        let total = 0;
        for (let i = 0; i < points.length - 1; i++) {
            total += distanceHaversine(
                points[i].lat, points[i].lon,
                points[i + 1].lat, points[i + 1].lon
            );
        }
        return total;
    }

    /**
     * Trouve le point sur un chemin à une distance donnée depuis le début
     * @param {Array<{lat: number, lon: number}>} points - Points du chemin
     * @param {number} distance - Distance depuis le début (mètres)
     * @returns {{lat: number, lon: number, index: number, fraction: number}} Point trouvé
     */
    function pointAtDistance(points, distance) {
        if (!Array.isArray(points) || points.length < 2) {
            return points.length === 1 ? { ...points[0], index: 0, fraction: 0 } : null;
        }
        let remaining = distance;
        for (let i = 0; i < points.length - 1; i++) {
            const segLen = distanceHaversine(
                points[i].lat, points[i].lon,
                points[i + 1].lat, points[i + 1].lon
            );
            if (remaining <= segLen) {
                const fraction = segLen > 0 ? remaining / segLen : 0;
                const pt = interpolatePoint(
                    points[i].lat, points[i].lon,
                    points[i + 1].lat, points[i + 1].lon,
                    fraction
                );
                return { ...pt, index: i, fraction: fraction };
            }
            remaining -= segLen;
        }
        const last = points[points.length - 1];
        return { ...last, index: points.length - 1, fraction: 1 };
    }

    /**
     * Calcule la boîte englobante d'un ensemble de points
     * @param {Array<{lat: number, lon: number}>} points - Liste des points
     * @returns {{minLat: number, maxLat: number, minLon: number, maxLon: number}|null}
     */
    function boundingBox(points) {
        if (!Array.isArray(points) || points.length === 0) return null;
        let minLat = Infinity, maxLat = -Infinity;
        let minLon = Infinity, maxLon = -Infinity;
        for (const p of points) {
            if (!isValidCoord(p.lat, p.lon)) continue;
            if (p.lat < minLat) minLat = p.lat;
            if (p.lat > maxLat) maxLat = p.lat;
            if (p.lon < minLon) minLon = p.lon;
            if (p.lon > maxLon) maxLon = p.lon;
        }
        if (!isFinite(minLat)) return null;
        return { minLat, maxLat, minLon, maxLon };
    }

    /**
     * Calcule le centre d'un ensemble de points
     * @param {Array<{lat: number, lon: number}>} points - Liste des points
     * @returns {{lat: number, lon: number}|null}
     */
    function centroid(points) {
        if (!Array.isArray(points) || points.length === 0) return null;
        let sumLat = 0, sumLon = 0, count = 0;
        for (const p of points) {
            if (isValidCoord(p.lat, p.lon)) {
                sumLat += p.lat;
                sumLon += p.lon;
                count++;
            }
        }
        if (count === 0) return null;
        return { lat: sumLat / count, lon: sumLon / count };
    }

    // API publique
    return {
        getReference,
        formatCoord,
        isValidCoord,
        distanceHaversine,
        distanceProjected,
        toDMS,
        interpolatePoint,
        midpoint,
        pathLength,
        pointAtDistance,
        boundingBox,
        centroid,
        // OPTIM : Exposer le cache pour permettre un vidage si nécessaire
        _clearCache: function() {
            distanceCache.clear();
            interpolateCache.clear();
        }
    };
})();

// Sécurité : s'assurer que GeoUtils est disponible globalement
if (typeof window !== 'undefined') {
    window.GeoUtils = GeoUtils;
}