// ============================================================
// subsurface.js – CP Engineer Pro – Module de visualisation sous-sol 3D
// VERSION 8.5 – OPTIMISATION : Pool d'objets, cache, rendu différé
// Dépend de Three.js, gis3d.js, coordUtils.js
// ============================================================

(function() {
    'use strict';

    // ============================================================
    // 1. CONFIGURATION
    // ============================================================
    const CONFIG = {
        defaultDepth: 0,
        maxDepth: 100,
        minDepth: -50,
        clipOpacity: 0.3,
        clipColor: 0x1a2a3a,
        gridColor: 0x06b6d4,
        gridOpacity: 0.3,
        colors: {
            pipeline: 0x3b82f6,
            cable: 0x10b981,
            anode: 0xf59e0b,
            groundbed: 0x8b5cf6,
            rectifier: 0xef4444,
            testPost: 0xfbbf24,
            wellCasing: 0x6b7280,
            generic: 0x06b6d4
        },
        referenceAltitude: 0,
        maxSubsurfaceObjects: 500,
        objectPoolSize: 50
    };

    // ============================================================
    // 2. VARIABLES
    // ============================================================
    let _isEnabled = false;
    let _clipPlane = null;
    let _clipPlaneHelper = null;
    let _gridHelper = null;
    let _subsurfaceGroup = null;
    let _depth = CONFIG.defaultDepth;
    let _scene = null;
    let _camera = null;
    let _renderer = null;
    let _controls = null;
    let _originalBackground = null;
    let _isInitialized = false;
    let _objects = {};
    let _updateTimeout = null;
    let _subsurfaceObjects = [];
    let _referenceAltitude = CONFIG.referenceAltitude;

    // OPTIM : Pool d'objets pour réutilisation
    let _objectPool = [];
    let _poolIndex = 0;

    // OPTIM : Cache des matériaux
    const _materialCache = new Map();

    // ============================================================
    // 3. FONCTIONS UTILITAIRES
    // ============================================================

    function getReferenceAltitude() {
        if (typeof CoordSystem !== 'undefined' && CoordSystem.getReference) {
            const ref = CoordSystem.getReference();
            if (ref && typeof ref.alt === 'number') {
                return ref.alt;
            }
        }
        return 0;
    }

    function depthToAltitude(depth) {
        return _referenceAltitude - depth;
    }

    function altitudeToDepth(altitude) {
        return _referenceAltitude - altitude;
    }

    function isBuried(equipment) {
        if (!equipment || !equipment.coordinates) return false;
        const coords = equipment.coordinates;
        let alt = 0;
        if (Array.isArray(coords) && coords.length > 0) {
            alt = coords[0].alt || 0;
        } else if (coords.alt !== undefined) {
            alt = coords.alt || 0;
        }
        return alt < _referenceAltitude - 0.5;
    }

    function getEquipmentDepth(equipment) {
        if (!equipment || !equipment.coordinates) return 0;
        const coords = equipment.coordinates;
        let alt = 0;
        if (Array.isArray(coords) && coords.length > 0) {
            alt = coords[0].alt || 0;
        } else if (coords.alt !== undefined) {
            alt = coords.alt || 0;
        }
        return Math.max(0, _referenceAltitude - alt);
    }

    // ============================================================
    // 4. INITIALISATION
    // ============================================================

    function init(scene, camera, renderer, controls) {
        if (_isInitialized) return;

        if (!scene || !camera || !renderer) {
            console.warn('[Subsurface] Paramètres manquants pour l\'initialisation');
            return;
        }

        _scene = scene;
        _camera = camera;
        _renderer = renderer;
        _controls = controls;

        _referenceAltitude = getReferenceAltitude();

        _subsurfaceGroup = new THREE.Group();
        _subsurfaceGroup.name = 'SubsurfaceGroup';
        _scene.add(_subsurfaceGroup);

        _clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);

        _createGridHelper();

        _isInitialized = true;
        console.log('[Subsurface] Initialisé avec altitude de référence:', _referenceAltitude);

        if (_isEnabled) {
            _enableSubsurface();
        }

        // OPTIM : Écouteurs avec debounce
        const debouncedUpdate = debounce(_updateSubsurface, 300);

        document.addEventListener('projectLoaded', function() {
            _referenceAltitude = getReferenceAltitude();
            if (_isEnabled) {
                debouncedUpdate();
            }
        });

        document.addEventListener('equipmentUpdated', function() {
            if (_isEnabled) {
                debouncedUpdate();
            }
        });

        document.addEventListener('dataSynced', function() {
            if (_isEnabled) {
                debouncedUpdate();
            }
        });
    }

    // ============================================================
    // 5. CRÉATION DES ÉLÉMENTS DE LA SCÈNE SOUS-SOL
    // ============================================================

    function _createGridHelper() {
        if (_gridHelper) {
            _subsurfaceGroup.remove(_gridHelper);
            _gridHelper = null;
        }

        const gridSize = 40;
        const divisions = 16;
        const grid = new THREE.GridHelper(gridSize, divisions, CONFIG.gridColor, CONFIG.gridColor);
        grid.material.transparent = true;
        grid.material.opacity = CONFIG.gridOpacity;
        grid.position.y = 0;
        grid.name = 'SubsurfaceGrid';
        _subsurfaceGroup.add(grid);
        _gridHelper = grid;
    }

    function _createClipPlaneVisual() {
        if (_clipPlaneHelper) {
            _subsurfaceGroup.remove(_clipPlaneHelper);
            _clipPlaneHelper = null;
        }

        const size = 50;
        const geometry = new THREE.PlaneGeometry(size, size);
        const material = new THREE.MeshBasicMaterial({
            color: CONFIG.clipColor,
            transparent: true,
            opacity: CONFIG.clipOpacity,
            side: THREE.DoubleSide,
            depthWrite: false
        });
        const plane = new THREE.Mesh(geometry, material);
        plane.rotation.x = -Math.PI / 2;
        plane.position.y = 0;
        plane.name = 'ClipPlaneVisual';
        _subsurfaceGroup.add(plane);
        _clipPlaneHelper = plane;
    }

    // ============================================================
    // 6. GESTION DU MODE SOUS-SOL
    // ============================================================

    function enable() {
        if (_isEnabled) return;
        _isEnabled = true;
        _enableSubsurface();
        _updateSubsurface();
        document.dispatchEvent(new CustomEvent('subsurfaceEnabled', {
            detail: { depth: _depth }
        }));
        console.log('[Subsurface] Mode sous-sol activé');
    }

    function disable() {
        if (!_isEnabled) return;
        _isEnabled = false;
        _disableSubsurface();
        document.dispatchEvent(new CustomEvent('subsurfaceDisabled'));
        console.log('[Subsurface] Mode sous-sol désactivé');
    }

    function toggle() {
        if (_isEnabled) {
            disable();
        } else {
            enable();
        }
        return _isEnabled;
    }

    function _enableSubsurface() {
        if (!_isInitialized || !_scene || !_renderer) return;

        if (_scene.background) {
            _originalBackground = _scene.background;
        }
        _scene.background = new THREE.Color(0x0a0a12);

        _renderer.localClippingEnabled = true;

        _createGridHelper();
        _createClipPlaneVisual();

        _applyClipping(true);
        _updateClipPlane();

        console.log('[Subsurface] Mode activé avec profondeur:', _depth);
    }

    function _disableSubsurface() {
        if (!_isInitialized || !_scene || !_renderer) return;

        if (_originalBackground) {
            _scene.background = _originalBackground;
            _originalBackground = null;
        } else {
            _scene.background = new THREE.Color(0x0a0e17);
        }

        _renderer.localClippingEnabled = false;

        if (_clipPlaneHelper) {
            _subsurfaceGroup.remove(_clipPlaneHelper);
            _clipPlaneHelper = null;
        }
        if (_gridHelper) {
            _subsurfaceGroup.remove(_gridHelper);
            _gridHelper = null;
        }

        _applyClipping(false);
        _clearSubsurfaceObjects();

        console.log('[Subsurface] Mode désactivé');
    }

    function _applyClipping(enable) {
        if (!_scene) return;

        _scene.traverse(function(child) {
            if (child.isMesh && child.material) {
                const materials = Array.isArray(child.material) ? child.material : [child.material];
                materials.forEach(mat => {
                    if (enable) {
                        if (!mat.clippingPlanes) {
                            mat.clippingPlanes = [];
                        }
                        if (!mat.clippingPlanes.includes(_clipPlane)) {
                            mat.clippingPlanes.push(_clipPlane);
                        }
                        mat.clipShadows = true;
                        mat.clipIntersection = false;
                    } else {
                        if (mat.clippingPlanes) {
                            const idx = mat.clippingPlanes.indexOf(_clipPlane);
                            if (idx !== -1) {
                                mat.clippingPlanes.splice(idx, 1);
                            }
                        }
                        mat.clipShadows = false;
                    }
                    mat.needsUpdate = true;
                });
            }
        });
    }

    function _updateClipPlane() {
        if (!_clipPlane) return;

        const y = -_depth;
        _clipPlane.constant = y;

        if (_clipPlaneHelper) {
            _clipPlaneHelper.position.y = y;
        }
        if (_gridHelper) {
            _gridHelper.position.y = y;
        }
    }

    // ============================================================
    // 7. MISE À JOUR DES OBJETS SOUS-SOL (OPTIMISÉ avec pool)
    // ============================================================

    function _updateSubsurface() {
        if (_updateTimeout) {
            clearTimeout(_updateTimeout);
            _updateTimeout = null;
        }

        _updateTimeout = setTimeout(() => {
            if (!_isEnabled || !_isInitialized) {
                _updateTimeout = null;
                return;
            }

            _clearSubsurfaceObjects();

            const projectId = ProjectManager.getCurrentProjectId();
            if (!projectId) {
                _updateTimeout = null;
                return;
            }

            const state = ProjectManager.getState();
            const equipments = state.equipments.filter(eq => eq.projectId === projectId && eq.included !== false);

            const buriedEquipments = equipments.filter(eq => isBuried(eq));

            if (buriedEquipments.length === 0) {
                _updateTimeout = null;
                return;
            }

            // OPTIM : Limiter le nombre d'objets pour les performances
            const toRender = buriedEquipments.slice(0, CONFIG.maxSubsurfaceObjects);

            toRender.forEach(eq => {
                _createSubsurfaceObject(eq);
            });

            _updateClipPlane();

            _updateTimeout = null;
            console.log('[Subsurface] Objets sous-sol mis à jour:', toRender.length);

        }, 300);
    }

    function _getFromPool() {
        if (_objectPool.length > 0) {
            return _objectPool.pop();
        }
        return null;
    }

    function _returnToPool(obj) {
        if (_objectPool.length < CONFIG.objectPoolSize) {
            _objectPool.push(obj);
        } else {
            // Nettoyer si le pool est plein
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
                if (Array.isArray(obj.material)) {
                    obj.material.forEach(m => m.dispose());
                } else {
                    obj.material.dispose();
                }
            }
        }
    }

    function _getMaterial(color, type) {
        const key = `${color}_${type}`;
        if (_materialCache.has(key)) {
            return _materialCache.get(key);
        }

        let material;
        if (type === 'pipeline' || type === 'well_casing') {
            material = new THREE.MeshStandardMaterial({
                color: color,
                metalness: 0.6,
                roughness: 0.4,
                transparent: true,
                opacity: 0.8
            });
        } else if (type === 'groundbed') {
            material = new THREE.MeshStandardMaterial({
                color: color,
                transparent: true,
                opacity: 0.3,
                metalness: 0.8,
                roughness: 0.3
            });
        } else {
            material = new THREE.MeshStandardMaterial({
                color: color,
                emissive: color,
                emissiveIntensity: 0.1,
                metalness: 0.5,
                roughness: 0.3
            });
        }

        _materialCache.set(key, material);
        return material;
    }

    function _createSubsurfaceObject(equipment) {
        if (!_subsurfaceGroup) return;

        const coords = equipment.coordinates;
        if (!coords) return;

        let position;
        if (typeof CoordSystem !== 'undefined' && CoordSystem.equipmentTo3D) {
            const pos = CoordSystem.equipmentTo3D(equipment);
            if (pos) {
                position = Array.isArray(pos) ? pos[0] : pos;
            }
        }

        if (!position) {
            const ref = { lat: 30.123456, lon: 8.123456, alt: 0 };
            const scale = 111000;
            let lat, lon, alt = 0;
            if (Array.isArray(coords) && coords.length > 0) {
                lat = coords[0].lat;
                lon = coords[0].lon;
                alt = coords[0].alt || 0;
            } else if (coords.lat !== undefined) {
                lat = coords.lat;
                lon = coords.lon;
                alt = coords.alt || 0;
            } else {
                return;
            }
            const x = (lon - ref.lon) * scale;
            const y = (alt - ref.alt);
            const z = (lat - ref.lat) * scale;
            position = new THREE.Vector3(x, y, z);
        }

        const colorMap = {
            'pipeline_enterre': CONFIG.colors.pipeline,
            'pipeline_offshore': CONFIG.colors.pipeline,
            'well_casing': CONFIG.colors.wellCasing,
            'groundbed': CONFIG.colors.groundbed,
            'anode': CONFIG.colors.anode,
            'rectifier': CONFIG.colors.rectifier,
            'testpost': CONFIG.colors.testPost,
            'cable': CONFIG.colors.cable
        };
        const color = colorMap[equipment.type] || CONFIG.colors.generic;

        // OPTIM : Réutiliser les objets du pool
        let mesh = _getFromPool();
        const type = equipment.type || 'generic';

        if (type === 'pipeline_enterre' || type === 'pipeline_offshore') {
            const dims = equipment.dimensions || {};
            const length = dims.longueur_m || 10;
            const diameter = dims.diametre_m || 0.5;

            if (!mesh || !mesh.geometry || mesh.geometry.parameters?.radius !== diameter/2) {
                if (mesh) {
                    _returnToPool(mesh);
                }
                const geometry = new THREE.CylinderGeometry(diameter/2, diameter/2, length, 8);
                const material = _getMaterial(color, 'pipeline');
                mesh = new THREE.Mesh(geometry, material);
            } else {
                // Réutiliser le mesh, mettre à jour la position
                mesh.scale.set(1, length / 1, 1);
            }
            mesh.rotation.x = Math.PI / 2;
            mesh.position.copy(position);
        } else if (type === 'groundbed') {
            const dims = equipment.dimensions || {};
            const totalDepth = dims.totalDepth || 20;

            if (!mesh || !mesh.geometry || mesh.geometry.parameters?.height !== totalDepth) {
                if (mesh) {
                    _returnToPool(mesh);
                }
                const geometry = new THREE.CylinderGeometry(0.3, 0.3, totalDepth, 8);
                const material = _getMaterial(color, 'groundbed');
                mesh = new THREE.Mesh(geometry, material);
            }
            mesh.position.copy(position);
        } else {
            if (!mesh || !mesh.geometry || mesh.geometry.type !== 'SphereGeometry') {
                if (mesh) {
                    _returnToPool(mesh);
                }
                const geometry = new THREE.SphereGeometry(0.2, 8, 8);
                const material = _getMaterial(color, 'generic');
                mesh = new THREE.Mesh(geometry, material);
            }
            mesh.position.copy(position);
        }

        mesh.userData = {
            equipmentId: equipment.id,
            tag: equipment.tag,
            type: equipment.type,
            isSubsurface: true
        };
        _subsurfaceGroup.add(mesh);
        _subsurfaceObjects.push(mesh);

        // OPTIM : Créer l'étiquette uniquement si l'équipement est sélectionné ou visible
        const label = _createSubsurfaceLabel(equipment.tag || equipment.id);
        label.position.set(position.x, position.y + 0.5, position.z);
        _subsurfaceGroup.add(label);
        _subsurfaceObjects.push(label);
    }

    function _createSubsurfaceLabel(text) {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');

        ctx.clearRect(0, 0, 128, 32);
        ctx.fillStyle = 'rgba(10, 14, 23, 0.7)';
        ctx.roundRect(4, 4, 120, 24, 4);
        ctx.fill();
        ctx.strokeStyle = 'rgba(6, 182, 212, 0.3)';
        ctx.lineWidth = 1;
        ctx.roundRect(4, 4, 120, 24, 4);
        ctx.stroke();

        ctx.fillStyle = '#94a3b8';
        ctx.font = '12px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 64, 17);

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;

        const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthWrite: false,
            sizeAttenuation: true
        });
        const sprite = new THREE.Sprite(material);
        sprite.scale.set(1.5, 0.4, 1);
        sprite.userData = { baseScale: 1.5, isSubsurface: true };
        return sprite;
    }

    function _clearSubsurfaceObjects() {
        _subsurfaceObjects.forEach(obj => {
            if (obj.parent) {
                obj.parent.remove(obj);
            }
            // OPTIM : Mettre les objets dans le pool pour réutilisation
            if (obj.isMesh) {
                _returnToPool(obj);
            } else if (obj.isSprite) {
                if (obj.material) obj.material.dispose();
            }
        });
        _subsurfaceObjects = [];
    }

    // ============================================================
    // 8. GESTION DE LA PROFONDEUR
    // ============================================================

    function setDepth(depth) {
        const newDepth = Math.max(CONFIG.minDepth, Math.min(CONFIG.maxDepth, depth));
        if (newDepth !== _depth) {
            _depth = newDepth;
            if (_isEnabled) {
                _updateClipPlane();
            }
            document.dispatchEvent(new CustomEvent('subsurfaceDepthChanged', {
                detail: { depth: _depth }
            }));
        }
    }

    function getDepth() {
        return _depth;
    }

    function increaseDepth(step = 1) {
        setDepth(_depth + step);
    }

    function decreaseDepth(step = 1) {
        setDepth(_depth - step);
    }

    // ============================================================
    // 9. DEBOUNCE
    // ============================================================
    function debounce(fn, delay) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => fn.apply(this, args), delay);
        };
    }

    // ============================================================
    // 10. API PUBLIQUE
    // ============================================================

    const Subsurface = {
        // Version du module sous-sol 3D (cycle de vie indépendant)
        VERSION: '8.5.0',

        init: function(scene, camera, renderer, controls) {
            init(scene, camera, renderer, controls);
        },
        enable: function() {
            enable();
        },
        disable: function() {
            disable();
        },
        toggle: function() {
            return toggle();
        },
        isEnabled: function() {
            return _isEnabled;
        },
        setDepth: function(depth) {
            setDepth(depth);
        },
        getDepth: function() {
            return getDepth();
        },
        increaseDepth: function(step) {
            increaseDepth(step);
        },
        decreaseDepth: function(step) {
            decreaseDepth(step);
        },
        update: function() {
            _updateSubsurface();
        },
        clear: function() {
            _clearSubsurfaceObjects();
            _materialCache.clear();
            _objectPool = [];
        },
        getReferenceAltitude: function() {
            return _referenceAltitude;
        },
        updateReferenceAltitude: function() {
            _referenceAltitude = getReferenceAltitude();
            if (_isEnabled) {
                _updateSubsurface();
            }
        },
        isBuried: function(equipment) {
            return isBuried(equipment);
        },
        getEquipmentDepth: function(equipment) {
            return getEquipmentDepth(equipment);
        }
    };

    // ============================================================
    // 11. INITIALISATION AUTOMATIQUE
    // ============================================================

    document.addEventListener('DOMContentLoaded', function() {
        const checkGis3D = setInterval(function() {
            if (typeof window.Gis3D !== 'undefined') {
                clearInterval(checkGis3D);
                const scene = window.Gis3D.getScene();
                const camera = window.Gis3D.getCamera();
                const renderer = window.Gis3D.getRenderer();
                const controls = window.Gis3D.getControls();
                if (scene && camera && renderer) {
                    Subsurface.init(scene, camera, renderer, controls);
                    console.log('[Subsurface] Initialisé automatiquement avec Gis3D');
                }
            }
        }, 500);

        document.addEventListener('gis3d:loaded', function(e) {
            const scene = e.detail.scene;
            const renderer = e.detail.renderer;
            const controls = e.detail.controls;
            let camera = e.detail.camera || (window.Gis3D ? window.Gis3D.getCamera() : null);
            if (!camera) {
                scene.traverse(function(child) {
                    if (child.isCamera && child.type === 'PerspectiveCamera') {
                        camera = child;
                    }
                });
            }
            if (camera) {
                Subsurface.init(scene, camera, renderer, controls);
                console.log('[Subsurface] Initialisé via événement gis3d:loaded');
            }
        });

        const btnSubsurface = document.getElementById('btnSubsurface');
        if (btnSubsurface) {
            btnSubsurface.addEventListener('click', function() {
                const enabled = Subsurface.toggle();
                this.classList.toggle('active', enabled);
                this.innerHTML = enabled ?
                    '<i class="fas fa-layer-group"></i> Masquer sous-sol' :
                    '<i class="fas fa-layer-group"></i> Afficher sous-sol';
                if (window.UI && typeof window.UI.showToast === 'function') {
                    window.UI.showToast(
                        enabled ? '🔽 Mode sous-sol activé' : '🔼 Mode sous-sol désactivé',
                        'info'
                    );
                }
            });
        }

        const depthSlider = document.getElementById('subsurfaceDepth');
        const depthValue = document.getElementById('subsurfaceDepthValue');
        if (depthSlider && depthValue) {
            depthSlider.addEventListener('input', function() {
                const val = parseFloat(this.value);
                Subsurface.setDepth(val);
                depthValue.textContent = val.toFixed(1) + ' m';
            });
        }

        document.addEventListener('keydown', function(e) {
            if (e.key === 's' && !e.ctrlKey && !e.metaKey) {
                const target = e.target;
                if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
                    return;
                }
                e.preventDefault();
                const btn = document.getElementById('btnSubsurface');
                if (btn) btn.click();
            }
        });

        document.addEventListener('keydown', function(e) {
            if (e.key === '+' || e.key === '=') {
                if (!e.ctrlKey && !e.metaKey) {
                    const target = e.target;
                    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
                        return;
                    }
                    e.preventDefault();
                    Subsurface.increaseDepth(1);
                    const slider = document.getElementById('subsurfaceDepth');
                    if (slider) {
                        slider.value = Subsurface.getDepth();
                        const val = document.getElementById('subsurfaceDepthValue');
                        if (val) val.textContent = Subsurface.getDepth().toFixed(1) + ' m';
                    }
                }
            }
            if (e.key === '-' || e.key === '_') {
                if (!e.ctrlKey && !e.metaKey) {
                    const target = e.target;
                    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
                        return;
                    }
                    e.preventDefault();
                    Subsurface.decreaseDepth(1);
                    const slider = document.getElementById('subsurfaceDepth');
                    if (slider) {
                        slider.value = Subsurface.getDepth();
                        const val = document.getElementById('subsurfaceDepthValue');
                        if (val) val.textContent = Subsurface.getDepth().toFixed(1) + ' m';
                    }
                }
            }
        });
    });

    window.Subsurface = Subsurface;

    console.log('[Subsurface] Module chargé avec succès (version optimisée).');

})();