// ============================================================
// coordUtils.js – CP Engineer Pro – Système de coordonnées unifié
// Version 1.1 – AJOUT : computeSpatialCenter, computeBoundingBox, computeAdaptiveScale
// ============================================================

(function() {
    'use strict';

    /**
     * Système de coordonnées unifié pour l'application.
     * Fournit des conversions entre WGS84 (lat/lon/alt), ENU local (x/y/z) et coordonnées 3D.
     * Utilise un point de référence par projet pour minimiser les erreurs numériques.
     */
    const CoordSystem = {
        /**
         * Point de référence pour le projet courant.
         */
        reference: {
            lat: 30.123456,
            lon: 8.123456,
            alt: 0
        },

        /**
         * Facteur d'échelle pour la conversion degrés → mètres.
         * Environ 111 000 m/deg à l'équateur.
         */
        scale: 111000,

        /**
         * Définit le point de référence pour le projet courant.
         */
        setReference: function(lat, lon, alt = 0) {
            if (!GeoUtils.isValidCoord(lat, lon)) {
                console.warn('[CoordSystem] Référence invalide, utilisation des valeurs par défaut.');
                return;
            }
            this.reference.lat = lat;
            this.reference.lon = lon;
            this.reference.alt = alt || 0;
            console.log(`[CoordSystem] Référence définie: lat=${lat}, lon=${lon}, alt=${alt}`);
        },

        /**
         * Récupère la référence actuelle.
         */
        getReference: function() {
            return { ...this.reference };
        },

        /**
         * Vérifie si une coordonnée GPS est valide (WGS84).
         */
        isValid: function(lat, lon, alt = 0) {
            return GeoUtils.isValidCoord(lat, lon) && typeof alt === 'number' && !isNaN(alt);
        },

        /**
         * Convertit des coordonnées WGS84 en coordonnées locales ENU (East, North, Up).
         */
        toLocal: function(lat, lon, alt) {
            if (!this.isValid(lat, lon, alt)) {
                console.warn('[CoordSystem] Coordonnées invalides pour toLocal:', { lat, lon, alt });
                return { x: 0, y: 0, z: 0 };
            }
            const dx = (lon - this.reference.lon) * this.scale;
            const dy = (alt - this.reference.alt);
            const dz = (lat - this.reference.lat) * this.scale;
            return { x: dx, y: dy, z: dz };
        },

        /**
         * Convertit des coordonnées locales ENU en coordonnées WGS84.
         */
        toWGS84: function(x, y, z) {
            if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number' || isNaN(x) || isNaN(y) || isNaN(z)) {
                console.warn('[CoordSystem] Coordonnées locales invalides pour toWGS84:', { x, y, z });
                return { lat: this.reference.lat, lon: this.reference.lon, alt: this.reference.alt };
            }
            return {
                lat: this.reference.lat + z / this.scale,
                lon: this.reference.lon + x / this.scale,
                alt: this.reference.alt + y
            };
        },

        /**
         * Convertit un objet équipement en coordonnées locales.
         */
        equipmentToLocal: function(equipment) {
            if (!equipment || !equipment.coordinates) return null;

            const coords = equipment.coordinates;
            if (Array.isArray(coords)) {
                return coords.map(p => {
                    if (p.lat !== undefined && p.lon !== undefined) {
                        return this.toLocal(p.lat, p.lon, p.alt || 0);
                    }
                    return { x: 0, y: 0, z: 0 };
                });
            } else if (coords.lat !== undefined && coords.lon !== undefined) {
                return this.toLocal(coords.lat, coords.lon, coords.alt || 0);
            }
            return null;
        },

        /**
         * Convertit un objet équipement en coordonnées 3D (Three.js Vector3).
         */
        equipmentTo3D: function(equipment) {
            const local = this.equipmentToLocal(equipment);
            if (!local) return null;
            if (Array.isArray(local)) {
                return local.map(p => new THREE.Vector3(p.x, p.y, p.z));
            }
            return new THREE.Vector3(local.x, local.y, local.z);
        },

        /**
         * Convertit des coordonnées WGS84 en coordonnées 3D (Three.js Vector3).
         */
        to3D: function(lat, lon, alt = 0) {
            const local = this.toLocal(lat, lon, alt);
            return new THREE.Vector3(local.x, local.y, local.z);
        },

        /**
         * Convertit des coordonnées 3D en WGS84.
         */
        from3D: function(vec) {
            return this.toWGS84(vec.x, vec.y, vec.z);
        },

        /**
         * Calcule la distance entre deux points GPS.
         */
        distance: function(p1, p2) {
            if (!this.isValid(p1.lat, p1.lon) || !this.isValid(p2.lat, p2.lon)) return 0;
            const a = this.toLocal(p1.lat, p1.lon, p1.alt || 0);
            const b = this.toLocal(p2.lat, p2.lon, p2.alt || 0);
            return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
        },

        /**
         * Calcule la longueur totale d'un pipeline (tableau de points).
         */
        pipelineLength: function(points) {
            if (!Array.isArray(points) || points.length < 2) return 0;
            let total = 0;
            for (let i = 0; i < points.length - 1; i++) {
                total += this.distance(points[i], points[i + 1]);
            }
            return total;
        },

        /**
         * Interpole un point le long d'un segment entre deux points GPS.
         */
        interpolate: function(p1, p2, fraction) {
            if (!this.isValid(p1.lat, p1.lon) || !this.isValid(p2.lat, p2.lon)) return null;
            const f = Math.max(0, Math.min(1, fraction));
            return {
                lat: p1.lat + (p2.lat - p1.lat) * f,
                lon: p1.lon + (p2.lon - p1.lon) * f,
                alt: (p1.alt || 0) + ((p2.alt || 0) - (p1.alt || 0)) * f
            };
        },

        /**
         * Trouve un point à une distance donnée le long d'un pipeline.
         */
        pointAtDistance: function(points, distance) {
            if (!Array.isArray(points) || points.length < 2 || distance < 0) return null;
            let remaining = distance;
            for (let i = 0; i < points.length - 1; i++) {
                const segLen = this.distance(points[i], points[i + 1]);
                if (remaining <= segLen) {
                    const fraction = segLen > 0 ? remaining / segLen : 0;
                    const pt = this.interpolate(points[i], points[i + 1], fraction);
                    return { ...pt, index: i, fraction: fraction };
                }
                remaining -= segLen;
            }
            const last = points[points.length - 1];
            return { ...last, index: points.length - 1, fraction: 1 };
        },

        /**
         * Calcule le centre spatial d'un ensemble d'équipements.
         * @param {Array} equipments - Liste des équipements
         * @returns {Object} { lat, lon, alt, minLat, maxLat, minLon, maxLon, count }
         */
        computeSpatialCenter: function(equipments) {
            if (!equipments || equipments.length === 0) {
                return { lat: this.reference.lat, lon: this.reference.lon, alt: 0, count: 0 };
            }

            let sumLat = 0, sumLon = 0, sumAlt = 0;
            let count = 0;
            let minLat = Infinity, maxLat = -Infinity;
            let minLon = Infinity, maxLon = -Infinity;

            const allCoords = [];

            for (const eq of equipments) {
                const coords = eq.coordinates;
                if (!coords) continue;

                let points = [];
                if (Array.isArray(coords)) {
                    points = coords;
                } else if (coords.lat !== undefined && coords.lon !== undefined) {
                    points = [coords];
                } else {
                    continue;
                }

                for (const p of points) {
                    const lat = parseFloat(p.lat);
                    const lon = parseFloat(p.lon);
                    const alt = parseFloat(p.alt || 0);
                    if (!this.isValid(lat, lon)) continue;
                    if (Math.abs(lat) < 1e-9 && Math.abs(lon) < 1e-9) continue;

                    sumLat += lat;
                    sumLon += lon;
                    sumAlt += alt;
                    count++;
                    allCoords.push({ lat, lon, alt });

                    if (lat < minLat) minLat = lat;
                    if (lat > maxLat) maxLat = lat;
                    if (lon < minLon) minLon = lon;
                    if (lon > maxLon) maxLon = lon;
                }
            }

            if (count === 0) {
                return { lat: this.reference.lat, lon: this.reference.lon, alt: 0, count: 0 };
            }

            return {
                lat: sumLat / count,
                lon: sumLon / count,
                alt: sumAlt / count,
                minLat: minLat,
                maxLat: maxLat,
                minLon: minLon,
                maxLon: maxLon,
                count: count,
                allCoords: allCoords
            };
        },

        /**
         * Calcule la boîte englobante d'un ensemble d'équipements.
         */
        computeBoundingBox: function(equipments) {
            const center = this.computeSpatialCenter(equipments);
            if (center.count === 0) {
                return {
                    minX: -10, maxX: 10,
                    minY: -10, maxY: 10,
                    minZ: -10, maxZ: 10
                };
            }

            // Convertir les coins en coordonnées locales
            const corners = [
                { lat: center.minLat, lon: center.minLon },
                { lat: center.minLat, lon: center.maxLon },
                { lat: center.maxLat, lon: center.minLon },
                { lat: center.maxLat, lon: center.maxLon }
            ];

            const localCoords = corners.map(c => this.toLocal(c.lat, c.lon, 0));

            return {
                minX: Math.min(...localCoords.map(c => c.x)),
                maxX: Math.max(...localCoords.map(c => c.x)),
                minY: Math.min(...localCoords.map(c => c.y)),
                maxY: Math.max(...localCoords.map(c => c.y)),
                minZ: Math.min(...localCoords.map(c => c.z)),
                maxZ: Math.max(...localCoords.map(c => c.z))
            };
        },

        /**
         * Calcule un facteur d'échelle adaptatif.
         */
        computeAdaptiveScale: function(equipments, viewportSize) {
            const bbox = this.computeBoundingBox(equipments);
            const width = bbox.maxX - bbox.minX;
            const depth = bbox.maxZ - bbox.minZ;
            const maxDim = Math.max(width, depth, 0.001);

            const vw = viewportSize?.width || 800;
            const vh = viewportSize?.height || 600;
            const viewMin = Math.min(vw, vh);

            // Cibler une taille de scène entre 10 et 50 unités
            const targetSize = Math.min(Math.max(maxDim * 0.3, 5), 50);
            const scale = targetSize / maxDim;

            return Math.max(0.01, Math.min(10, scale));
        },

        /**
         * Valide et normalise les coordonnées d'un équipement.
         */
        normalizeEquipment: function(eq) {
            if (!eq || !eq.coordinates) return eq;
            const coords = eq.coordinates;
            if (Array.isArray(coords)) {
                eq.coordinates = coords.filter(p => this.isValid(p.lat, p.lon, p.alt));
            } else if (coords.lat !== undefined && coords.lon !== undefined) {
                if (!this.isValid(coords.lat, coords.lon, coords.alt)) {
                    eq.coordinates = null;
                }
            } else {
                eq.coordinates = null;
            }
            return eq;
        },

        /**
         * Réinitialise le cache (utile en cas de changement de projet).
         */
        reset: function() {
            this.reference.lat = 30.123456;
            this.reference.lon = 8.123456;
            this.reference.alt = 0;
        }
    };

    // Exposer globalement
    window.CoordSystem = CoordSystem;

    console.log('[CoordSystem] Initialisé avec succès.');
})();