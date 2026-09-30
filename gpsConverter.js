// ============================================================
// gpsConverter.js – CP Engineer Pro – Convertisseur GPS universel
// Version 1.1 – Gestion des tableaux de points issus de l'import Excel
// ============================================================

(function() {
    'use strict';

    /**
     * Convertisseur GPS universel
     * Gère tous les formats de coordonnées possibles et les convertit en coordonnées 3D
     */
    const GpsConverter = {
        // Version du convertisseur GPS (cycle de vie indépendant)
        VERSION: '1.1.0',

        /**
         * Référence géographique pour la conversion (par défaut: centre de l'Algérie)
         */
        _reference: {
            lat: 30.123456,
            lon: 8.123456,
            alt: 0
        },

        /**
         * Facteur d'échelle (mètres par degré)
         * ~111 km par degré à l'équateur
         */
        _scale: 111000,

        /**
         * Exagération verticale
         */
        _verticalExaggeration: 1.0,

        /**
         * Définit la référence géographique
         */
        setReference: function(lat, lon, alt) {
            if (this._isValidCoord(lat, lon)) {
                this._reference.lat = parseFloat(lat);
                this._reference.lon = parseFloat(lon);
                this._reference.alt = parseFloat(alt) || 0;
                console.log('[GpsConverter] Référence définie:', this._reference);
            } else {
                console.warn('[GpsConverter] Référence invalide, conservation des valeurs par défaut');
            }
        },

        /**
         * Récupère la référence
         */
        getReference: function() {
            return { ...this._reference };
        },

        /**
         * Définit l'exagération verticale
         */
        setVerticalExaggeration: function(factor) {
            this._verticalExaggeration = Math.max(0.1, Math.min(20, factor));
        },

        /**
         * Vérifie si une coordonnée est valide
         */
        _isValidCoord: function(lat, lon) {
            if (lat === undefined || lat === null || lon === undefined || lon === null) return false;
            const latNum = parseFloat(lat);
            const lonNum = parseFloat(lon);
            if (isNaN(latNum) || isNaN(lonNum)) return false;
            if (latNum < -90 || latNum > 90) return false;
            if (lonNum < -180 || lonNum > 180) return false;
            return true;
        },

        /**
         * Extrait les coordonnées de n'importe quel format
         * @param {*} data - Données d'entrée (objet, tableau, chaîne, etc.)
         * @returns {Array<{lat, lon, alt}>} Tableau de points valides
         */
        extractCoordinates: function(data) {
            if (!data) return [];

            let points = [];

            // === CAS 1: Tableau de points (Array d'objets ou Array de tableaux) ===
            if (Array.isArray(data)) {
                if (data.length === 0) return [];
                
                // Vérifier si c'est un tableau de nombres [lat, lon, alt]
                if (typeof data[0] === 'number') {
                    const lat = data[0];
                    const lon = data[1] || 0;
                    const alt = data[2] || 0;
                    if (this._isValidCoord(lat, lon) && !(Math.abs(lat) < 1e-9 && Math.abs(lon) < 1e-9)) {
                        points.push({ lat: parseFloat(lat), lon: parseFloat(lon), alt: parseFloat(alt) });
                    }
                    return points;
                }
                
                // Tableau de points [{lat, lon}, ...] ou [[lat, lon], ...]
                for (const item of data) {
                    if (Array.isArray(item) && item.length >= 2) {
                        const lat = parseFloat(item[0]);
                        const lon = parseFloat(item[1]);
                        const alt = parseFloat(item[2]) || 0;
                        if (this._isValidCoord(lat, lon) && !(Math.abs(lat) < 1e-9 && Math.abs(lon) < 1e-9)) {
                            points.push({ lat, lon, alt });
                        }
                    } else if (typeof item === 'object' && item !== null) {
                        const extracted = this._extractFromObject(item);
                        if (extracted && !(Math.abs(extracted.lat) < 1e-9 && Math.abs(extracted.lon) < 1e-9)) {
                            points.push(extracted);
                        }
                    }
                }
                return points;
            }

            // === CAS 2: Chaîne de caractères ===
            if (typeof data === 'string') {
                return this._extractFromString(data);
            }

            // === CAS 3: Objet ===
            if (typeof data === 'object' && data !== null) {
                const point = this._extractFromObject(data);
                if (point && !(Math.abs(point.lat) < 1e-9 && Math.abs(point.lon) < 1e-9)) {
                    points.push(point);
                }
                
                // Si l'objet contient plusieurs points (geometry.coordinates, etc.)
                if (data.geometry && data.geometry.coordinates) {
                    const geoPoints = this._extractFromGeometry(data.geometry);
                    if (geoPoints.length > 0) {
                        return geoPoints;
                    }
                }
                
                // Si l'objet a une propriété 'coordinates' qui est un tableau
                if (data.coordinates && Array.isArray(data.coordinates)) {
                    const coordPoints = this.extractCoordinates(data.coordinates);
                    if (coordPoints.length > 0) {
                        return coordPoints;
                    }
                }
                
                // Parcourir toutes les propriétés pour trouver des points
                const values = Object.values(data);
                for (const val of values) {
                    if (Array.isArray(val) && val.length >= 2 && typeof val[0] === 'number') {
                        const extracted = this.extractCoordinates(val);
                        if (extracted.length > 0) {
                            return extracted;
                        }
                    }
                    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
                        const extracted = this._extractFromObject(val);
                        if (extracted && !(Math.abs(extracted.lat) < 1e-9 && Math.abs(extracted.lon) < 1e-9)) {
                            points.push(extracted);
                        }
                    }
                }
                
                return points;
            }

            return points;
        },

        /**
         * Extrait un point depuis une chaîne de caractères
         */
        _extractFromString: function(str) {
            const cleaned = str.trim();
            const points = [];
            
            // Format: "lat, lon" ou "lat lon" ou "lat/lon"
            const numbers = cleaned.match(/[-+]?\d*\.?\d+/g);
            if (numbers && numbers.length >= 2) {
                const lat = parseFloat(numbers[0]);
                const lon = parseFloat(numbers[1]);
                const alt = numbers.length > 2 ? parseFloat(numbers[2]) : 0;
                if (this._isValidCoord(lat, lon) && !(Math.abs(lat) < 1e-9 && Math.abs(lon) < 1e-9)) {
                    points.push({ lat, lon, alt: isNaN(alt) ? 0 : alt });
                }
            }
            
            // Format DMS: "30°09'43.2\"N 8°03'01.2\"E"
            const dmsMatch = cleaned.match(/(\d+)°\s*(\d+)'\s*([\d.]+)"?\s*([NS])\s*(\d+)°\s*(\d+)'\s*([\d.]+)"?\s*([EW])/i);
            if (dmsMatch) {
                const latDeg = parseFloat(dmsMatch[1]);
                const latMin = parseFloat(dmsMatch[2]);
                const latSec = parseFloat(dmsMatch[3]);
                const latDir = dmsMatch[4].toUpperCase();
                const lonDeg = parseFloat(dmsMatch[5]);
                const lonMin = parseFloat(dmsMatch[6]);
                const lonSec = parseFloat(dmsMatch[7]);
                const lonDir = dmsMatch[8].toUpperCase();
                
                let lat = latDeg + latMin/60 + latSec/3600;
                let lon = lonDeg + lonMin/60 + lonSec/3600;
                if (latDir === 'S') lat = -lat;
                if (lonDir === 'W') lon = -lon;
                
                if (this._isValidCoord(lat, lon)) {
                    points.push({ lat, lon, alt: 0 });
                }
            }
            
            return points;
        },

        /**
         * Extrait un point depuis un objet
         */
        _extractFromObject: function(obj) {
            if (!obj || typeof obj !== 'object') return null;
            
            // Liste des noms de propriétés possibles pour la latitude
            const latNames = ['lat', 'latitude', 'Lat', 'Latitude', 'LAT', 'LATITUDE', 'y', 'Y'];
            const lonNames = ['lon', 'lng', 'longitude', 'Lon', 'Lng', 'Longitude', 'LON', 'LNG', 'LONGITUDE', 'x', 'X'];
            const altNames = ['alt', 'altitude', 'Alt', 'Altitude', 'ALT', 'ALTITUDE', 'z', 'Z', 'elevation', 'Elevation'];
            
            let lat = undefined;
            let lon = undefined;
            let alt = 0;
            
            // Rechercher la latitude
            for (const name of latNames) {
                if (obj[name] !== undefined && obj[name] !== null) {
                    const val = parseFloat(obj[name]);
                    if (!isNaN(val)) {
                        lat = val;
                        break;
                    }
                }
            }
            
            // Rechercher la longitude
            for (const name of lonNames) {
                if (obj[name] !== undefined && obj[name] !== null) {
                    const val = parseFloat(obj[name]);
                    if (!isNaN(val)) {
                        lon = val;
                        break;
                    }
                }
            }
            
            // Rechercher l'altitude
            for (const name of altNames) {
                if (obj[name] !== undefined && obj[name] !== null) {
                    const val = parseFloat(obj[name]);
                    if (!isNaN(val)) {
                        alt = val;
                        break;
                    }
                }
            }
            
            // Si on a trouvé lat/lon, retourner le point
            if (lat !== undefined && lon !== undefined && this._isValidCoord(lat, lon)) {
                return { lat: parseFloat(lat), lon: parseFloat(lon), alt: parseFloat(alt) || 0 };
            }
            
            // Recherche dans les propriétés imbriquées (geo, location, position, etc.)
            const nestedKeys = ['geo', 'location', 'position', 'coordinates', 'point', 'geometry'];
            for (const key of nestedKeys) {
                if (obj[key] && typeof obj[key] === 'object') {
                    const result = this._extractFromObject(obj[key]);
                    if (result) return result;
                }
            }
            
            return null;
        },

        /**
         * Extrait les points depuis une géométrie GeoJSON
         */
        _extractFromGeometry: function(geometry) {
            if (!geometry || !geometry.type || !geometry.coordinates) return [];
            
            const coords = geometry.coordinates;
            const type = geometry.type;
            
            if (type === 'Point') {
                if (Array.isArray(coords) && coords.length >= 2) {
                    const lon = parseFloat(coords[0]);
                    const lat = parseFloat(coords[1]);
                    const alt = parseFloat(coords[2]) || 0;
                    if (this._isValidCoord(lat, lon)) {
                        return [{ lat, lon, alt }];
                    }
                }
                return [];
            }
            
            if (type === 'LineString' || type === 'MultiPoint') {
                if (!Array.isArray(coords) || coords.length === 0) return [];
                const points = [];
                for (const coord of coords) {
                    if (Array.isArray(coord) && coord.length >= 2) {
                        const lon = parseFloat(coord[0]);
                        const lat = parseFloat(coord[1]);
                        const alt = parseFloat(coord[2]) || 0;
                        if (this._isValidCoord(lat, lon)) {
                            points.push({ lat, lon, alt });
                        }
                    }
                }
                return points;
            }
            
            if (type === 'Polygon' || type === 'MultiLineString') {
                if (!Array.isArray(coords) || coords.length === 0) return [];
                const points = [];
                for (const ring of coords) {
                    if (!Array.isArray(ring)) continue;
                    for (const coord of ring) {
                        if (Array.isArray(coord) && coord.length >= 2) {
                            const lon = parseFloat(coord[0]);
                            const lat = parseFloat(coord[1]);
                            const alt = parseFloat(coord[2]) || 0;
                            if (this._isValidCoord(lat, lon)) {
                                points.push({ lat, lon, alt });
                            }
                        }
                    }
                }
                return points;
            }
            
            return [];
        },

        /**
         * Convertit des coordonnées GPS en coordonnées locales (ENU)
         */
        toLocal: function(lat, lon, alt) {
            if (!this._isValidCoord(lat, lon)) {
                return { x: 0, y: 0, z: 0 };
            }
            
            const latNum = parseFloat(lat);
            const lonNum = parseFloat(lon);
            const altNum = parseFloat(alt) || 0;
            
            const dx = (lonNum - this._reference.lon) * this._scale;
            const dy = (altNum - this._reference.alt) * this._verticalExaggeration;
            const dz = (latNum - this._reference.lat) * this._scale;
            
            return { x: dx, y: dy, z: dz };
        },

        /**
         * Convertit des coordonnées GPS en vecteur 3D (Three.js Vector3)
         */
        to3D: function(lat, lon, alt) {
            const local = this.toLocal(lat, lon, alt);
            if (typeof THREE !== 'undefined') {
                return new THREE.Vector3(local.x, local.y, local.z);
            }
            return local;
        },

        /**
         * Convertit n'importe quel format de coordonnées en tableau de vecteurs 3D
         * @param {*} data - Données d'entrée (tout format)
         * @returns {Array<THREE.Vector3>} Tableau de vecteurs 3D
         */
        convertTo3D: function(data) {
            const points = this.extractCoordinates(data);
            if (points.length === 0) return [];
            
            const vectors = [];
            for (const p of points) {
                const vec = this.to3D(p.lat, p.lon, p.alt);
                if (vec) vectors.push(vec);
            }
            return vectors;
        },

        /**
         * Convertit n'importe quel format de coordonnées en tableau de points locaux
         */
        convertToLocal: function(data) {
            const points = this.extractCoordinates(data);
            if (points.length === 0) return [];
            
            return points.map(p => this.toLocal(p.lat, p.lon, p.alt));
        },

        /**
         * Détecte automatiquement le format et extrait les coordonnées d'un équipement
         */
        extractFromEquipment: function(equipment) {
            if (!equipment) return [];
            
            // Essayer différentes propriétés possibles
            const possibleProps = [
                'coordinates',
                'gps',
                'geometry',
                'location',
                'position',
                'point',
                'geo'
            ];
            
            for (const prop of possibleProps) {
                if (equipment[prop]) {
                    const extracted = this.extractCoordinates(equipment[prop]);
                    if (extracted.length > 0) {
                        return extracted;
                    }
                }
            }
            
            // Rechercher lat/lon directement dans l'objet
            const direct = this._extractFromObject(equipment);
            if (direct) {
                return [direct];
            }
            
            // Rechercher des propriétés qui contiennent des coordonnées
            for (const [key, value] of Object.entries(equipment)) {
                if (typeof value === 'object' && value !== null) {
                    const extracted = this.extractCoordinates(value);
                    if (extracted.length > 0) {
                        return extracted;
                    }
                }
            }
            
            return [];
        },

        /**
         * Convertit un équipement complet en coordonnées 3D
         */
        equipmentTo3D: function(equipment) {
            const points = this.extractFromEquipment(equipment);
            if (points.length === 0) return null;
            
            const vectors = points.map(p => this.to3D(p.lat, p.lon, p.alt));
            
            // Si un seul point, retourner le vecteur directement
            if (vectors.length === 1) {
                return vectors[0];
            }
            
            // Sinon retourner le tableau
            return vectors;
        },

        /**
         * Calcule la distance entre deux points GPS
         */
        distance: function(p1, p2) {
            const a = this.toLocal(p1.lat, p1.lon, p1.alt || 0);
            const b = this.toLocal(p2.lat, p2.lon, p2.alt || 0);
            return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2) + Math.pow(a.z - b.z, 2));
        },

        /**
         * Calcule la longueur d'un tracé
         */
        pathLength: function(points) {
            if (!points || points.length < 2) return 0;
            let total = 0;
            for (let i = 0; i < points.length - 1; i++) {
                total += this.distance(points[i], points[i + 1]);
            }
            return total;
        },

        /**
         * Interpole un point le long d'un segment
         */
        interpolate: function(p1, p2, fraction) {
            const f = Math.max(0, Math.min(1, fraction));
            return {
                lat: p1.lat + (p2.lat - p1.lat) * f,
                lon: p1.lon + (p2.lon - p1.lon) * f,
                alt: (p1.alt || 0) + ((p2.alt || 0) - (p1.alt || 0)) * f
            };
        },

        /**
         * Trouve un point à une distance donnée le long d'un tracé
         */
        pointAtDistance: function(points, distance) {
            if (!points || points.length < 2 || distance < 0) return null;
            
            let remaining = distance;
            for (let i = 0; i < points.length - 1; i++) {
                const segLen = this.distance(points[i], points[i + 1]);
                if (remaining <= segLen) {
                    const fraction = segLen > 0 ? remaining / segLen : 0;
                    const pt = this.interpolate(points[i], points[i + 1], fraction);
                    return {
                        ...pt,
                        index: i,
                        fraction: fraction,
                        segmentLength: segLen
                    };
                }
                remaining -= segLen;
            }
            
            const last = points[points.length - 1];
            return {
                ...last,
                index: points.length - 1,
                fraction: 1,
                segmentLength: 0
            };
        },

        /**
         * Formate une coordonnée pour l'affichage
         */
        format: function(lat, lon, decimals) {
            const d = decimals || 6;
            if (!this._isValidCoord(lat, lon)) return '?, ?';
            return `${parseFloat(lat).toFixed(d)}°N, ${parseFloat(lon).toFixed(d)}°E`;
        },

        /**
         * Formate en DMS
         */
        toDMS: function(lat, lon) {
            if (!this._isValidCoord(lat, lon)) return '?, ?';
            
            const latDeg = Math.floor(Math.abs(lat));
            const latMin = Math.floor((Math.abs(lat) - latDeg) * 60);
            const latSec = ((Math.abs(lat) - latDeg - latMin/60) * 3600).toFixed(1);
            const latDir = lat >= 0 ? 'N' : 'S';
            
            const lonDeg = Math.floor(Math.abs(lon));
            const lonMin = Math.floor((Math.abs(lon) - lonDeg) * 60);
            const lonSec = ((Math.abs(lon) - lonDeg - lonMin/60) * 3600).toFixed(1);
            const lonDir = lon >= 0 ? 'E' : 'W';
            
            return `${latDeg}°${latMin}'${latSec}"${latDir} ${lonDeg}°${lonMin}'${lonSec}"${lonDir}`;
        }
    };

    // Exposer globalement
    window.GpsConverter = GpsConverter;

    // ============================================================
    // INTÉGRATION AVEC LE SYSTÈME EXISTANT
    // ============================================================

    /**
     * Patch pour remplacer normalizeGPS dans gis3d.js
     * Cette fonction est automatiquement appelée si Gis3D est chargé
     */
    function patchGis3D() {
        if (typeof window.Gis3D !== 'undefined') {
            window.Gis3D.convertGPS = function(data) {
                return GpsConverter.convertTo3D(data);
            };
            
            window.Gis3D.extractGPS = function(data) {
                return GpsConverter.extractCoordinates(data);
            };
            
            window.Gis3D.equipmentTo3D = function(equipment) {
                return GpsConverter.equipmentTo3D(equipment);
            };
            
            console.log('[GpsConverter] Patch appliqué à Gis3D');
        }
    }

    if (document.readyState === 'complete') {
        patchGis3D();
    } else {
        document.addEventListener('DOMContentLoaded', patchGis3D);
    }

    document.addEventListener('gis3d:loaded', patchGis3D);

    window.superNormalizeGPS = function(coords) {
        if (!coords) return null;
        const points = GpsConverter.extractCoordinates(coords);
        if (points.length === 0) {
            if (typeof coords === 'object') {
                const lat = coords.lat || coords.latitude || coords.Lat || coords.Latitude;
                const lon = coords.lon || coords.longitude || coords.Lon || coords.Longitude;
                if (lat !== undefined && lon !== undefined) {
                    const latNum = parseFloat(lat);
                    const lonNum = parseFloat(lon);
                    if (!isNaN(latNum) && !isNaN(lonNum) && latNum >= -90 && latNum <= 90 && lonNum >= -180 && lonNum <= 180) {
                        return [{ lat: latNum, lon: lonNum, alt: 0 }];
                    }
                }
            }
            return null;
        }
        return points;
    };

    console.log('[GpsConverter] Module de conversion GPS universel chargé');
    console.log('[GpsConverter] Formats supportés: {lat, lon} / [lat, lon] / GeoJSON / Chaînes DMS');

})();