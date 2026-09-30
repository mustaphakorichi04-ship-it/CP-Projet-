# ============================================================
# coordUtils.py – CP Engineer Pro – Système de coordonnées unifié (Backend)
# Module version : 1.1.0 (cycle de vie indépendant du module)
# Version applicative : définie par APP_CONFIG.VERSION (engine.js Frontend)
#                       et BACKEND_VERSION (backend.py)
# ============================================================
# NOTE (ROLE.txt §5, §7, §12) :
#   La version de CE module est indépendante de la version applicative.
#   Elle est exposée explicitement via CoordSystem.VERSION et
#   CoordSystem.MODULE_NAME pour éviter toute confusion avec
#   APP_CONFIG.VERSION (Frontend) ou BACKEND_VERSION (backend.py).
# ============================================================

import math
from typing import Dict, List, Optional, Any, Union


class CoordSystem:
    """
    Système de coordonnées unifié pour le backend.
    Fournit des conversions entre WGS84 (lat/lon/alt), ENU local (x/y/z)
    et coordonnées 3D. Utilise un point de référence par projet pour
    minimiser les erreurs numériques.
    """

    # ============================================================
    # MÉTADONNÉES DU MODULE (versioning explicite — ROLE.txt §5)
    # ============================================================
    # Version du module CoordSystem (cycle de vie indépendant).
    # NE PAS confondre avec BACKEND_VERSION (backend.py) ni avec
    # APP_CONFIG.VERSION (engine.js Frontend).
    VERSION = "1.1.0"
    MODULE_NAME = "CoordSystem"
    MODULE_DESCRIPTION = "Unified coordinate system for WGS84 / ENU / 3D conversions"

    # Facteur d'échelle pour la conversion degrés → mètres (approximatif)
    # Environ 111 000 m/deg à l'équateur
    SCALE = 111000.0

    def __init__(self,
                 ref_lat: float = 30.123456,
                 ref_lon: float = 8.123456,
                 ref_alt: float = 0.0):
        """
        Initialise le système de coordonnées avec un point de référence.

        :param ref_lat: Latitude de référence (degrés)
        :param ref_lon: Longitude de référence (degrés)
        :param ref_alt: Altitude de référence (mètres)
        """
        self.ref_lat = ref_lat
        self.ref_lon = ref_lon
        self.ref_alt = ref_alt

    # ============================================================
    # MÉTHODES D'INFORMATION
    # ============================================================
    @classmethod
    def get_version(cls) -> str:
        """Retourne la version du module CoordSystem (cycle indépendant)."""
        return cls.VERSION

    @classmethod
    def get_metadata(cls) -> Dict[str, Any]:
        """Retourne les métadonnées du module (diagnostic)."""
        return {
            "moduleName": cls.MODULE_NAME,
            "moduleVersion": cls.VERSION,
            "description": cls.MODULE_DESCRIPTION,
            "scale": cls.SCALE
        }

    def set_reference(self, lat: float, lon: float, alt: float = 0.0) -> None:
        """
        Définit le point de référence.

        :param lat: Latitude (degrés)
        :param lon: Longitude (degrés)
        :param alt: Altitude (mètres)
        """
        if self.is_valid_coord(lat, lon):
            self.ref_lat = lat
            self.ref_lon = lon
            self.ref_alt = alt or 0.0
        else:
            raise ValueError(
                f"Coordonnées de référence invalides: lat={lat}, lon={lon}"
            )

    def get_reference(self) -> Dict[str, float]:
        """
        Récupère la référence actuelle.

        :return: Dictionnaire { 'lat': ..., 'lon': ..., 'alt': ... }
        """
        return {
            'lat': self.ref_lat,
            'lon': self.ref_lon,
            'alt': self.ref_alt
        }

    @staticmethod
    def is_valid_coord(lat: float, lon: float) -> bool:
        """
        Vérifie si une coordonnée GPS est valide (WGS84).

        :param lat: Latitude
        :param lon: Longitude
        :return: True si valide
        """
        if lat is None or lon is None:
            return False
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            return False
        if math.isnan(lat) or math.isnan(lon):
            return False
        if not math.isfinite(lat) or not math.isfinite(lon):
            return False
        if lat < -90.0 or lat > 90.0:
            return False
        if lon < -180.0 or lon > 180.0:
            return False
        return True

    @staticmethod
    def is_valid_alt(alt: float) -> bool:
        """
        Vérifie si une altitude est valide.

        :param alt: Altitude (mètres)
        :return: True si valide
        """
        if alt is None:
            return False
        if not isinstance(alt, (int, float)):
            return False
        if math.isnan(alt):
            return False
        if not math.isfinite(alt):
            return False
        return True

    def to_local(self,
                 lat: float,
                 lon: float,
                 alt: float = 0.0) -> Dict[str, float]:
        """
        Convertit des coordonnées WGS84 en coordonnées locales ENU
        (East, North, Up).

        :param lat: Latitude (degrés)
        :param lon: Longitude (degrés)
        :param alt: Altitude (mètres)
        :return: Dictionnaire { 'x': East, 'y': Up, 'z': North }
        """
        if not self.is_valid_coord(lat, lon):
            return {'x': 0.0, 'y': 0.0, 'z': 0.0}
        alt_val = alt if self.is_valid_alt(alt) else 0.0

        dx = (lon - self.ref_lon) * self.SCALE
        dy = alt_val - self.ref_alt
        dz = (lat - self.ref_lat) * self.SCALE
        return {'x': dx, 'y': dy, 'z': dz}

    def to_wgs84(self,
                 x: float,
                 y: float,
                 z: float) -> Dict[str, float]:
        """
        Convertit des coordonnées locales ENU en coordonnées WGS84.

        :param x: East (mètres)
        :param y: Up (mètres)
        :param z: North (mètres)
        :return: Dictionnaire { 'lat': ..., 'lon': ..., 'alt': ... }
        """
        if not all(
            isinstance(v, (int, float)) and not math.isnan(v)
            for v in (x, y, z)
        ):
            return {
                'lat': self.ref_lat,
                'lon': self.ref_lon,
                'alt': self.ref_alt
            }

        return {
            'lat': self.ref_lat + z / self.SCALE,
            'lon': self.ref_lon + x / self.SCALE,
            'alt': self.ref_alt + y
        }

    def equipment_to_local(
        self,
        equipment: Dict[str, Any]
    ) -> Optional[Union[Dict[str, float], List[Dict[str, float]]]]:
        """
        Convertit les coordonnées d'un équipement en coordonnées locales.

        :param equipment: Dictionnaire de l'équipement avec clé 'coordinates'
        :return: Coordonnées locales (objet ou liste) ou None si invalide
        """
        coords = equipment.get('coordinates')
        if not coords:
            return None

        if isinstance(coords, list):
            # Pipeline : tableau de points
            result = []
            for p in coords:
                if isinstance(p, dict) and 'lat' in p and 'lon' in p:
                    lat = p.get('lat')
                    lon = p.get('lon')
                    alt = p.get('alt', 0.0)
                    if self.is_valid_coord(lat, lon):
                        result.append(self.to_local(lat, lon, alt))
            return result if result else None

        elif isinstance(coords, dict) and 'lat' in coords and 'lon' in coords:
            # Point unique
            lat = coords.get('lat')
            lon = coords.get('lon')
            alt = coords.get('alt', 0.0)
            if self.is_valid_coord(lat, lon):
                return self.to_local(lat, lon, alt)

        return None

    def distance(self,
                 p1: Dict[str, float],
                 p2: Dict[str, float]) -> float:
        """
        Calcule la distance entre deux points GPS.

        :param p1: { 'lat': ..., 'lon': ..., 'alt': ... }
        :param p2: { 'lat': ..., 'lon': ..., 'alt': ... }
        :return: Distance en mètres
        """
        if not (
            self.is_valid_coord(p1.get('lat', 0.0), p1.get('lon', 0.0)) and
            self.is_valid_coord(p2.get('lat', 0.0), p2.get('lon', 0.0))
        ):
            return 0.0

        a = self.to_local(p1['lat'], p1['lon'], p1.get('alt', 0.0))
        b = self.to_local(p2['lat'], p2['lon'], p2.get('alt', 0.0))

        dx = a['x'] - b['x']
        dy = a['y'] - b['y']
        dz = a['z'] - b['z']
        return math.sqrt(dx * dx + dy * dy + dz * dz)

    def pipeline_length(self,
                        points: List[Dict[str, float]]) -> float:
        """
        Calcule la longueur totale d'un pipeline (tableau de points).

        :param points: Liste de { 'lat': ..., 'lon': ..., 'alt': ... }
        :return: Longueur en mètres
        """
        if not points or len(points) < 2:
            return 0.0
        total = 0.0
        for i in range(len(points) - 1):
            total += self.distance(points[i], points[i + 1])
        return total

    def interpolate(self,
                    p1: Dict[str, float],
                    p2: Dict[str, float],
                    fraction: float) -> Optional[Dict[str, float]]:
        """
        Interpole un point le long d'un segment entre deux points GPS.

        :param p1: { 'lat': ..., 'lon': ..., 'alt': ... }
        :param p2: { 'lat': ..., 'lon': ..., 'alt': ... }
        :param fraction: 0..1
        :return: { 'lat': ..., 'lon': ..., 'alt': ... } ou None
        """
        if not (
            self.is_valid_coord(p1.get('lat', 0.0), p1.get('lon', 0.0)) and
            self.is_valid_coord(p2.get('lat', 0.0), p2.get('lon', 0.0))
        ):
            return None

        f = max(0.0, min(1.0, fraction))
        return {
            'lat': p1['lat'] + (p2['lat'] - p1['lat']) * f,
            'lon': p1['lon'] + (p2['lon'] - p1['lon']) * f,
            'alt': (
                p1.get('alt', 0.0) +
                (p2.get('alt', 0.0) - p1.get('alt', 0.0)) * f
            )
        }

    def point_at_distance(self,
                          points: List[Dict[str, float]],
                          distance: float) -> Optional[Dict[str, float]]:
        """
        Trouve un point à une distance donnée le long d'un pipeline.

        :param points: Liste de { 'lat': ..., 'lon': ..., 'alt': ... }
        :param distance: Distance depuis le début (mètres)
        :return: { 'lat': ..., 'lon': ..., 'alt': ...,
                   'index': ..., 'fraction': ... } ou None
        """
        if not points or len(points) < 2 or distance < 0:
            return None

        remaining = distance
        for i in range(len(points) - 1):
            seg_len = self.distance(points[i], points[i + 1])
            if remaining <= seg_len:
                fraction = remaining / seg_len if seg_len > 0 else 0.0
                pt = self.interpolate(points[i], points[i + 1], fraction)
                if pt:
                    pt['index'] = i
                    pt['fraction'] = fraction
                return pt
            remaining -= seg_len

        # Au-delà de la fin, retourner le dernier point
        last = points[-1].copy()
        last['index'] = len(points) - 1
        last['fraction'] = 1.0
        return last

    def normalize_equipment(self,
                            equipment: Dict[str, Any]) -> Dict[str, Any]:
        """
        Valide et normalise les coordonnées d'un équipement.

        :param equipment: Dictionnaire de l'équipement
        :return: Équipement avec coordonnées normalisées
        """
        if not equipment:
            return equipment

        coords = equipment.get('coordinates')
        if not coords:
            return equipment

        if isinstance(coords, list):
            # Filtrer les points invalides
            valid_points = []
            for p in coords:
                if isinstance(p, dict) and 'lat' in p and 'lon' in p:
                    lat = p.get('lat')
                    lon = p.get('lon')
                    if self.is_valid_coord(lat, lon):
                        valid_points.append({
                            'lat': lat,
                            'lon': lon,
                            'alt': (
                                p.get('alt', 0.0)
                                if self.is_valid_alt(p.get('alt'))
                                else 0.0
                            )
                        })
            equipment['coordinates'] = valid_points if valid_points else None

        elif isinstance(coords, dict) and 'lat' in coords and 'lon' in coords:
            lat = coords.get('lat')
            lon = coords.get('lon')
            if not self.is_valid_coord(lat, lon):
                equipment['coordinates'] = None
            else:
                equipment['coordinates'] = {
                    'lat': lat,
                    'lon': lon,
                    'alt': (
                        coords.get('alt', 0.0)
                        if self.is_valid_alt(coords.get('alt'))
                        else 0.0
                    )
                }
        else:
            equipment['coordinates'] = None

        return equipment

    def validate_coordinates(
        self,
        coordinates: Union[Dict, List]
    ) -> bool:
        """
        Valide des coordonnées génériques.

        :param coordinates: Coordonnées (objet ou liste)
        :return: True si valides
        """
        if not coordinates:
            return False

        if isinstance(coordinates, list):
            if len(coordinates) == 0:
                return False
            for p in coordinates:
                if not isinstance(p, dict) or 'lat' not in p or 'lon' not in p:
                    return False
                if not self.is_valid_coord(
                    p.get('lat', 0.0),
                    p.get('lon', 0.0)
                ):
                    return False
            return True

        elif isinstance(coordinates, dict):
            if 'lat' not in coordinates or 'lon' not in coordinates:
                return False
            return self.is_valid_coord(
                coordinates.get('lat', 0.0),
                coordinates.get('lon', 0.0)
            )

        return False


# ============================================================
# FONCTIONS UTILITAIRES
# ============================================================
def get_default_coord_system() -> CoordSystem:
    """
    Retourne une instance du système de coordonnées avec la référence
    par défaut.
    """
    return CoordSystem()


def get_coord_system_from_project(project: Dict[str, Any]) -> CoordSystem:
    """
    Crée un système de coordonnées à partir des données d'un projet.

    :param project: Dictionnaire du projet
    :return: CoordSystem configuré
    """
    cs = CoordSystem()
    # Essayer de trouver des coordonnées dans les équipements du projet
    if project and 'data' in project:
        data = project.get('data', {})
        equipments = data.get('equipments', [])
        for eq in equipments:
            coords = eq.get('coordinates')
            if coords:
                if isinstance(coords, dict) and 'lat' in coords and 'lon' in coords:
                    cs.set_reference(
                        coords['lat'],
                        coords['lon'],
                        coords.get('alt', 0.0)
                    )
                    break
                elif isinstance(coords, list) and len(coords) > 0:
                    first = coords[0]
                    if isinstance(first, dict) and 'lat' in first and 'lon' in first:
                        cs.set_reference(
                            first['lat'],
                            first['lon'],
                            first.get('alt', 0.0)
                        )
                        break
    return cs


def get_module_version() -> str:
    """
    Retourne la version du module CoordSystem (cycle de vie indépendant).
    Utilitaire exposé pour les modules appelants (backend.py, etc.).
    """
    return CoordSystem.VERSION


# ============================================================
# FIN DE coordUtils.py (MODULE VERSION 1.1.0)
# ============================================================